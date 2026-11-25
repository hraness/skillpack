/**
 * Forwarding for the `mac-ui` lane (heavy compute reuses it; see
 * compute-forward.ts). On a workstation that is configured to
 * forward (for example the owner's own Mac), UI-driving native work never runs
 * locally: host-run ships the current commit and uncommitted changes to the
 * configured Mac over ssh, runs the same command there under that host's
 * `host-run --lane=mac-ui` inside the user's GUI session, streams the output
 * back, and returns the remote exit code.
 *
 * Transport: a `git bundle` of HEAD (only the commits the remote clone lacks)
 * plus a binary patch of the working tree, sent over the same ssh connection
 * that runs the job. Nothing is pushed to origin and no remote checkout,
 * index or branch is touched: the remote side builds a `git clone --shared`
 * throwaway tree in its own state directory and deletes it afterwards.
 *
 * No local lease is claimed. The forwarded run uses none of this machine's
 * scarce capabilities, and holding a lease while waiting on another host
 * would block local work on external state.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

export const forwardUnavailableExitCode = 69;
export const forwardUnavailableCode = "MAC_UI_FORWARD_FAILED";
export const remoteScriptPath = join(import.meta.dir, "mac-ui-remote.sh");

/** Largest bundle + patch payload host-run will send. */
export const maxPayloadBytes = 512 * 1024 * 1024;
const queueAllowanceMilliseconds = 2 * 60 * 60_000;
/** The remote may first wait for its CI machine lock (machine-lock.ts caps that wait at 2 h). */
const machineLockAllowanceMilliseconds = 2 * 60 * 60_000;
const defaultRemoteHoldMilliseconds = 60 * 60_000;
const preparationAllowanceMilliseconds = 15 * 60_000;
const unboundedHoldCeilingMilliseconds = 24 * 60 * 60_000;
const cancelGraceMilliseconds = 120_000;

export class ForwardUnavailableError extends Error {
  readonly code = forwardUnavailableCode;

  constructor(message: string) {
    super(message);
    this.name = "ForwardUnavailableError";
  }
}

export type RemoteForwardConfig = {
  readonly forwardTo: string;
  readonly remoteHostRun: string;
  /** Largest one-time full bundle sent to seed a repository the remote lacks. */
  readonly seedMaxBytes?: number;
  readonly source: string;
};

/** Heavy compute forwarding: `{ "compute": { "forwardTo": "hra2", "modes": ["heavy", "exclusive"] } }`. */
export type ComputeForwardConfig = RemoteForwardConfig & {
  /** Upper bound on all cached compute workspaces on the remote, GiB. */
  readonly cacheGiB: number;
  /** Evict idle cached workspaces while the remote disk has less free space than this, GiB. */
  readonly minFreeGiB: number;
  readonly modes: readonly ("heavy" | "exclusive")[];
  /** Cached workspaces per repository; concurrent runs beyond this wait. */
  readonly slots: number;
};

export type RemoteConfigs = {
  readonly compute: ComputeForwardConfig | null;
  readonly macUi: RemoteForwardConfig | null;
};

export const defaultSeedMaxMiB = 2048;

/** `$XDG_CONFIG_HOME/host-run/remote.json`, else `~/.config/host-run/remote.json`. */
export function remoteConfigPath(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const xdg = environment.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "") {
    if (!isAbsolute(xdg)) throw new Error("XDG_CONFIG_HOME must be absolute");
    return join(resolve(xdg), "host-run", "remote.json");
  }
  return join(resolve(environment.HOME || userHome), ".config", "host-run", "remote.json");
}

const sshHostPattern = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,252}$/u;

function parseForwardTarget(
  value: unknown,
  key: string,
  source: string,
  extraKeys: readonly string[],
): { readonly entry: Record<string, unknown>; readonly target: RemoteForwardConfig } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: ${key} must be an object`);
  }
  const entry = value as Record<string, unknown>;
  for (const name of Object.keys(entry)) {
    if (name !== "forwardTo" && name !== "remoteHostRun" && name !== "seedMaxMiB" && !extraKeys.includes(name)) {
      throw new Error(`${source}: ${key} has an unknown key: ${name}`);
    }
  }
  if (typeof entry.forwardTo !== "string" || !sshHostPattern.test(entry.forwardTo)) {
    throw new Error(`${source}: ${key}.forwardTo must be an ssh host name or alias`);
  }
  let remoteHostRun = "host-run";
  if (entry.remoteHostRun !== undefined) {
    if (
      typeof entry.remoteHostRun !== "string"
      || !(entry.remoteHostRun === "host-run" || (isAbsolute(entry.remoteHostRun) && normalize(entry.remoteHostRun) === entry.remoteHostRun))
      || /[\0-\x1f\x7f]/u.test(entry.remoteHostRun)
    ) {
      throw new Error(`${source}: ${key}.remoteHostRun must be "host-run" or a normalized absolute path`);
    }
    remoteHostRun = entry.remoteHostRun;
  }
  const seedMaxMiB = boundedInteger(entry.seedMaxMiB, defaultSeedMaxMiB, `${key}.seedMaxMiB`, source, 0, 16_384);
  return {
    entry,
    target: { forwardTo: entry.forwardTo, remoteHostRun, seedMaxBytes: seedMaxMiB * 1_048_576, source },
  };
}

function boundedInteger(value: unknown, fallback: number, name: string, source: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${source}: ${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * Parses remote.json: `macUi` (UI-driving work, always forwarded) and
 * `compute` (heavy builds, forwarded when possible, else run here).
 * `remoteHostRun` (optional) names the remote command; it defaults to
 * `host-run` on the remote PATH. Unknown keys and malformed values fail, so a
 * typo never silently changes where work runs.
 */
export function parseRemoteConfigs(text: string, source = "remote.json"): RemoteConfigs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object`);
  }
  const root = parsed as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== "macUi" && key !== "compute") throw new Error(`${source} has an unknown key: ${key}`);
  }
  const macUi = root.macUi === undefined ? null : parseForwardTarget(root.macUi, "macUi", source, []).target;
  let compute: ComputeForwardConfig | null = null;
  if (root.compute !== undefined) {
    const { entry, target } = parseForwardTarget(root.compute, "compute", source, ["modes", "cacheGiB", "minFreeGiB", "slots"]);
    let modes: ("heavy" | "exclusive")[] = ["heavy", "exclusive"];
    if (entry.modes !== undefined) {
      const value = entry.modes;
      if (
        !Array.isArray(value) || value.length === 0
        || !value.every((mode) => mode === "heavy" || mode === "exclusive")
      ) {
        throw new Error(`${source}: compute.modes must be a non-empty list of "heavy" and "exclusive"`);
      }
      modes = [...new Set(value as ("heavy" | "exclusive")[])];
    }
    compute = {
      ...target,
      cacheGiB: boundedInteger(entry.cacheGiB, 80, "compute.cacheGiB", source, 1, 4096),
      minFreeGiB: boundedInteger(entry.minFreeGiB, 60, "compute.minFreeGiB", source, 1, 4096),
      modes,
      slots: boundedInteger(entry.slots, 2, "compute.slots", source, 1, 8),
    };
  }
  return { compute, macUi };
}

/** The `macUi` entry of remote.json, or null. */
export function parseRemoteForwardConfig(text: string, source = "remote.json"): RemoteForwardConfig | null {
  return parseRemoteConfigs(text, source).macUi;
}

/**
 * Absent default file means run locally; anything unreadable or malformed
 * throws. `LOCAL_EFFICIENCY_REMOTE_CONFIG` names an explicit file instead,
 * which must exist, so the variable can redirect forwarding but never turn it
 * off.
 */
export function resolveRemoteForwardConfig(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): RemoteForwardConfig | null {
  return resolveRemoteConfigs(environment, userHome).macUi;
}

/** Both remote.json entries; an absent default file means neither. */
export function resolveRemoteConfigs(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): RemoteConfigs {
  const explicit = environment.LOCAL_EFFICIENCY_REMOTE_CONFIG;
  if (explicit !== undefined && explicit !== "" && !isAbsolute(explicit)) {
    throw new Error("LOCAL_EFFICIENCY_REMOTE_CONFIG must be absolute");
  }
  const path = explicit !== undefined && explicit !== "" ? explicit : remoteConfigPath(environment, userHome);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      && (explicit === undefined || explicit === "")
    ) return { compute: null, macUi: null };
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRemoteConfigs(text, path);
}

/** Validates an `--artifacts` path: relative to the repo root, no `..`. */
export function validateArtifactPath(value: string): string {
  if (value === "" || isAbsolute(value) || /[\0-\x1f\x7f]/u.test(value)) {
    throw new Error(`invalid --artifacts path: ${JSON.stringify(value)}`);
  }
  const cleaned = normalize(value).replace(/\/+$/u, "");
  if (cleaned === "" || cleaned === "." || cleaned === ".." || cleaned.startsWith("../") || cleaned.startsWith("-")) {
    throw new Error(`--artifacts must name a path inside the repository: ${value}`);
  }
  return cleaned;
}

/** `git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@github.com/o/r.git` -> `github.com/o/r`. */
export function normalizeOriginUrl(url: string): string {
  let value = url.trim();
  const scp = /^[^/@:]+@([^:/]+):(.+)$/u.exec(value);
  if (scp !== null && !value.includes("://")) {
    value = `${scp[1]}/${scp[2]}`;
  } else {
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "").replace(/^[^/@]*@/u, "");
    value = value.replace(/^([^/:]+):\d+\//u, "$1/");
  }
  value = value.replace(/\/+$/u, "").replace(/\.git$/u, "");
  return value.toLowerCase();
}

/** `dir`/`file`: a checkout under ~/src. `seed`: a bare repository host-run seeded into its own state. */
export type RemoteRepository = { readonly kind: "dir" | "file" | "seed"; readonly origin: string; readonly path: string };

export function parseRemoteRepositoryList(output: string): RemoteRepository[] {
  const repositories: RemoteRepository[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const [kind, path, ...rest] = line.split("\t");
    const origin = rest.join("\t");
    if ((kind !== "dir" && kind !== "file" && kind !== "seed") || path === undefined || path === "" || origin === "") continue;
    repositories.push({ kind, origin, path });
  }
  return repositories;
}

/**
 * Picks the remote clone of the same origin: prefer a directory named like the
 * repository, then a primary checkout (`.git` directory), then path order. A
 * seeded repository is used only when ~/src has no clone.
 */
export function selectRemoteRepository(
  repositories: readonly RemoteRepository[],
  localOrigin: string,
): RemoteRepository | null {
  const wanted = normalizeOriginUrl(localOrigin);
  const name = wanted.split("/").at(-1) ?? "";
  const matches = repositories.filter((entry) => normalizeOriginUrl(entry.origin) === wanted);
  const score = (entry: RemoteRepository): number =>
    entry.kind === "seed" ? 4 : (basename(entry.path).toLowerCase() === name ? 0 : 2) + (entry.kind === "dir" ? 0 : 1);
  return [...matches].sort((left, right) => score(left) - score(right) || left.path.localeCompare(right.path))[0] ?? null;
}

/** POSIX single-quote quoting; the remote login shell parses the ssh command line. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export const sshOptions: readonly string[] = Object.freeze([
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=6",
]);

/** argv for `ssh HOST bash -c SCRIPT host-run-remote SUBCOMMAND ARGS...`. */
export function sshCommand(
  host: string,
  script: string,
  subcommand: string,
  arguments_: readonly string[],
): string[] {
  const remote = ["bash", "-c", script, "host-run-remote", subcommand, ...arguments_]
    .map(shellQuote)
    .join(" ");
  return ["ssh", ...sshOptions, host, remote];
}

export type ForwardRequest = {
  readonly artifacts: readonly string[];
  readonly command: readonly string[];
  readonly cwd: string;
  readonly label: string;
  readonly maxHoldMilliseconds?: number | null;
  readonly mode: "shared" | "heavy" | "exclusive";
};

/** The remote host-run argv: same mode, label and max hold, on the forwarded lane. */
export function remoteHostRunArguments(request: ForwardRequest, lane: "mac-ui" | "compute" = "mac-ui"): string[] {
  return [
    `--mode=${request.mode}`,
    `--lane=${lane}`,
    `--label=${request.label}`,
    ...(request.maxHoldMilliseconds === undefined
      ? []
      : [`--max-hold=${request.maxHoldMilliseconds === null ? "none" : `${request.maxHoldMilliseconds}ms`}`]),
    "--",
    ...request.command,
  ];
}

/** Bound on the whole forwarded run: queue allowance + hold + preparation. */
export function forwardDeadlineMilliseconds(maxHoldMilliseconds: number | null | undefined): number {
  const hold = maxHoldMilliseconds === undefined
    ? defaultRemoteHoldMilliseconds
    : maxHoldMilliseconds === null
      ? unboundedHoldCeilingMilliseconds
      : maxHoldMilliseconds;
  return machineLockAllowanceMilliseconds + queueAllowanceMilliseconds + hold + preparationAllowanceMilliseconds;
}

export function newForwardId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "").replace("T", "-");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

export type RunResult = { readonly status: number | null; readonly stdout: Buffer; readonly stderr: string };

export type ForwardDependencies = {
  /** Runs a short command to completion. */
  readonly run: (
    argv: readonly string[],
    options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs: number },
  ) => RunResult;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly log: (line: string) => void;
};

function systemRun(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs: number },
): RunResult {
  const [program, ...rest] = argv;
  const result = spawnSync(program!, rest, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: maxPayloadBytes,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
  });
  return {
    status: result.error === undefined ? result.status : null,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: `${result.stderr?.toString("utf8") ?? ""}${result.error === undefined ? "" : String(result.error.message)}`,
  };
}

export function defaultForwardDependencies(environment: Readonly<NodeJS.ProcessEnv> = process.env): ForwardDependencies {
  return {
    environment,
    log: (line) => console.error(line),
    run: systemRun,
  };
}

export function lastLines(text: string, count = 3): string {
  return text.trim().split("\n").slice(-count).join(" | ");
}

export type LocalRepository = {
  readonly head: string;
  readonly origin: string;
  readonly prefix: string;
  readonly root: string;
};

export function git(
  deps: ForwardDependencies,
  cwd: string,
  arguments_: readonly string[],
  environment?: NodeJS.ProcessEnv,
): RunResult {
  return deps.run(["git", ...arguments_], {
    cwd,
    env: environment ?? { ...deps.environment },
    timeoutMs: 120_000,
  });
}

function gitText(deps: ForwardDependencies, cwd: string, arguments_: readonly string[], what: string): string {
  const result = git(deps, cwd, arguments_);
  if (result.status !== 0) {
    throw new ForwardUnavailableError(`${what}: ${lastLines(result.stderr) || `git ${arguments_.join(" ")} failed`}`);
  }
  return result.stdout.toString("utf8").replace(/\n$/u, "");
}

export function inspectLocalRepository(deps: ForwardDependencies, cwd: string, lane = "mac-ui"): LocalRepository {
  const root = gitText(deps, cwd, ["rev-parse", "--show-toplevel"], `${lane} forwarding needs a Git repository`);
  const prefix = gitText(deps, cwd, ["rev-parse", "--show-prefix"], "cannot resolve the working directory inside the repository");
  const head = gitText(deps, cwd, ["rev-parse", "--verify", "HEAD^{commit}"], "the repository has no commit to forward");
  const origin = gitText(deps, cwd, ["remote", "get-url", "origin"], `${lane} forwarding needs an origin remote to find the same repository on the remote Mac`);
  return { head, origin, prefix: prefix.replace(/\/$/u, ""), root };
}

/**
 * A binary patch from HEAD to the working tree, including untracked files that
 * are not ignored. A temporary index keeps the caller's real index untouched.
 */
export function workingTreePatch(deps: ForwardDependencies, root: string, scratch: string): Buffer {
  const index = join(scratch, "index");
  const environment = { ...deps.environment, GIT_INDEX_FILE: index };
  for (const arguments_ of [["read-tree", "HEAD"], ["add", "-A", "--", "."]]) {
    const result = git(deps, root, arguments_, environment);
    if (result.status !== 0) {
      throw new ForwardUnavailableError(`could not capture uncommitted changes: ${lastLines(result.stderr)}`);
    }
  }
  const diff = git(deps, root, ["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "HEAD"], environment);
  if (diff.status !== 0) throw new ForwardUnavailableError(`could not capture uncommitted changes: ${lastLines(diff.stderr)}`);
  return diff.stdout;
}

export function remoteCall(
  deps: ForwardDependencies,
  config: RemoteForwardConfig,
  script: string,
  subcommand: string,
  arguments_: readonly string[],
  timeoutMs = 60_000,
): RunResult {
  return deps.run(sshCommand(config.forwardTo, script, subcommand, arguments_), {
    env: { ...deps.environment },
    timeoutMs,
  });
}

function unreachable(config: RemoteForwardConfig, result: RunResult, lane: string): ForwardUnavailableError {
  const reason = `cannot reach ${config.forwardTo} over ssh (${lastLines(result.stderr) || `exit ${result.status ?? "timeout"}`})`;
  return new ForwardUnavailableError(lane === "mac-ui"
    ? `cannot reach ${config.forwardTo} over ssh to run mac-ui work (${lastLines(result.stderr) || `exit ${result.status ?? "timeout"}`}).`
      + ` UI-driving tests never run on this workstation; fix the connection, or remove ${config.source} to run them here`
    : reason);
}

/** planForward found no clone of the repository on the remote. */
export class NoRemoteCloneError extends ForwardUnavailableError {
  constructor(message: string, readonly local: LocalRepository) {
    super(message);
    this.name = "NoRemoteCloneError";
  }
}

export type ForwardPlan = {
  readonly bundleNeeded: boolean;
  readonly haves: readonly string[];
  readonly local: LocalRepository;
  readonly remoteRepository: string;
};

/** Finds the remote clone and which commits it already has. No side effects. */
export function planForward(
  deps: ForwardDependencies,
  config: RemoteForwardConfig,
  script: string,
  cwd: string,
  lane = "mac-ui",
): ForwardPlan {
  const local = inspectLocalRepository(deps, cwd, lane);
  const listed = remoteCall(deps, config, script, "list", []);
  if (listed.status !== 0) throw unreachable(config, listed, lane);
  const repository = selectRemoteRepository(parseRemoteRepositoryList(listed.stdout.toString("utf8")), local.origin);
  if (repository === null) {
    throw new NoRemoteCloneError(
      `${config.forwardTo} has no clone of ${normalizeOriginUrl(local.origin)} under ~/src`
      + (lane === "mac-ui" ? "; clone it there first (host-run never runs mac-ui work on this workstation)" : ""),
      local,
    );
  }
  const refs = git(deps, local.root, [
    "for-each-ref", "--sort=-committerdate", "--count=100", "--format=%(objectname)", "refs/remotes", "refs/tags",
  ]);
  const candidates = [...new Set([
    local.head,
    ...(refs.status === 0 ? refs.stdout.toString("utf8").split("\n").filter((line) => /^[0-9a-f]{40,64}$/u.test(line)) : []),
  ])];
  const have = remoteCall(deps, config, script, "have", [repository.path, ...candidates]);
  if (have.status !== 0) throw unreachable(config, have, lane);
  const haves = have.stdout.toString("utf8").split("\n").filter((line) => candidates.includes(line));
  return {
    bundleNeeded: !haves.includes(local.head),
    haves: haves.filter((sha) => sha !== local.head),
    local,
    remoteRepository: repository.path,
  };
}

/** `https://user:token@host/o/r` -> `https://host/o/r`; scp-style `git@host:o/r` is kept. */
export function originWithoutCredentials(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/iu, "$1");
}

/** Directory name for a repository in the remote's host-run state: `github.com-o-r`. */
export function repositoryKey(origin: string): string {
  const key = normalizeOriginUrl(origin).replace(/[^a-z0-9._-]+/gu, "-").replace(/^[.-]+/u, "").slice(0, 120);
  if (key === "") throw new ForwardUnavailableError(`cannot derive a repository name from origin ${origin}`);
  return key;
}

/**
 * Sends a full bundle of the local repository (HEAD, branches, tags and
 * remote-tracking refs) once, so a remote without the repository under ~/src
 * gets a bare copy in ~/.local/state/host-run/seed. Only Git objects and refs
 * travel: no config, no hooks, and the origin URL loses any embedded
 * credentials. Later runs send only the commits that copy lacks.
 */
export function seedRemoteRepository(
  deps: ForwardDependencies,
  config: RemoteForwardConfig,
  script: string,
  local: LocalRepository,
): void {
  const limit = config.seedMaxBytes ?? defaultSeedMaxMiB * 1_048_576;
  const name = normalizeOriginUrl(local.origin);
  if (limit === 0) {
    throw new ForwardUnavailableError(`${config.forwardTo} has no clone of ${name}, and seeding is off (seedMaxMiB is 0 in ${config.source})`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "host-run-seed-"));
  try {
    const bundlePath = join(scratch, "seed.bundle");
    const startedAt = Date.now();
    const bundle = deps.run(["git", "bundle", "create", "--quiet", bundlePath, "HEAD", "--branches", "--tags", "--remotes"], {
      cwd: local.root,
      env: { ...deps.environment },
      timeoutMs: 30 * 60_000,
    });
    if (bundle.status !== 0) throw new ForwardUnavailableError(`could not bundle ${name} to seed ${config.forwardTo}: ${lastLines(bundle.stderr)}`);
    const size = statSync(bundlePath).size;
    const mib = Math.max(1, Math.round(size / 1_048_576));
    if (size > limit) {
      throw new ForwardUnavailableError(
        `${config.forwardTo} has no clone of ${name}, and a full copy is ${mib} MiB (seed limit ${Math.round(limit / 1_048_576)} MiB);`
        + ` clone it under ~/src there, or raise seedMaxMiB in ${config.source}`,
      );
    }
    deps.log(
      `[host-run] ${config.forwardTo} has no clone of ${name}; sending a one-time copy (${mib} MiB)`
      + " to ~/.local/state/host-run/seed there",
    );
    const [program, ...rest] = sshCommand(config.forwardTo, script, "seed", [repositoryKey(local.origin), originWithoutCredentials(local.origin)]);
    const input = openSync(bundlePath, "r");
    let result;
    try {
      result = spawnSync(program!, rest, {
        env: { ...deps.environment },
        stdio: [input, "pipe", "pipe"],
        timeout: 60 * 60_000,
      });
    } finally {
      closeSync(input);
    }
    if (result.status !== 0) {
      throw new ForwardUnavailableError(
        `could not seed ${config.forwardTo} with ${name}: ${lastLines(result.stderr?.toString("utf8") ?? "") || `exit ${result.status ?? "timeout"}`}`,
      );
    }
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    deps.log(`[host-run] seeded ${config.forwardTo} with ${name} in ${seconds}s; later runs send only new commits`);
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

/** planForward, seeding the remote first when it has no clone at all. */
export function planOrSeed(
  deps: ForwardDependencies,
  config: RemoteForwardConfig,
  script: string,
  cwd: string,
  lane = "mac-ui",
): ForwardPlan {
  try {
    return planForward(deps, config, script, cwd, lane);
  } catch (error: unknown) {
    if (!(error instanceof NoRemoteCloneError)) throw error;
    seedRemoteRepository(deps, config, script, error.local);
    return planForward(deps, config, script, cwd, lane);
  }
}

/** Writes `payload.tar` (bundle when needed, patch) into scratch and returns its path. */
export function buildPayload(deps: ForwardDependencies, plan: ForwardPlan, scratch: string): string {
  const payloadDirectory = join(scratch, "payload");
  const made = deps.run(["mkdir", "-p", payloadDirectory], { timeoutMs: 10_000 });
  if (made.status !== 0) throw new ForwardUnavailableError("cannot create a scratch directory");
  if (plan.bundleNeeded) {
    const bundle = git(deps, plan.local.root, [
      "bundle", "create", "--quiet", join(payloadDirectory, "bundle"), "HEAD",
      ...(plan.haves.length === 0 ? [] : ["--not", ...plan.haves]),
    ]);
    if (bundle.status !== 0) throw new ForwardUnavailableError(`could not bundle HEAD: ${lastLines(bundle.stderr)}`);
  }
  writeFileSync(join(payloadDirectory, "patch"), workingTreePatch(deps, plan.local.root, scratch));
  const tarPath = join(scratch, "payload.tar");
  const tar = deps.run(["tar", "-cf", tarPath, "-C", payloadDirectory, "."], { timeoutMs: 300_000 });
  if (tar.status !== 0) throw new ForwardUnavailableError(`could not package the forwarded payload: ${lastLines(tar.stderr)}`);
  const size = statSync(tarPath).size;
  if (size > maxPayloadBytes) {
    throw new ForwardUnavailableError(
      `the forwarded commit bundle and uncommitted changes are ${Math.round(size / 1_048_576)} MiB (limit 512 MiB);`
      + " commit and push large files, or add build output to .gitignore",
    );
  }
  return tarPath;
}

export function signalExitCode(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 };
  return 128 + (numbers[signal] ?? 15);
}

/**
 * Runs the job on the remote Mac and streams its output. Local INT/TERM/HUP
 * asks the remote job to stop and waits (bounded) for its status.
 */
export function streamRemoteRun(
  deps: ForwardDependencies,
  config: RemoteForwardConfig,
  script: string,
  runArguments: readonly string[],
  payloadPath: string,
  deadlineMs: number,
  onCancel: () => void,
  subcommand: "run" | "compute" = "run",
): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }> {
  const lane = subcommand === "run" ? "mac-ui" : "compute";
  return new Promise((resolveRun, reject) => {
    const [program, ...rest] = sshCommand(config.forwardTo, script, subcommand, runArguments);
    const input = openSync(payloadPath, "r");
    // Own process group: a terminal Ctrl-C reaches host-run, which stops the
    // remote job deliberately, instead of killing ssh mid-stream.
    const child = spawn(program!, rest, {
      detached: true,
      env: { ...deps.environment },
      stdio: [input, "inherit", "inherit"],
    });
    closeSync(input);
    let received: NodeJS.Signals | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stopSsh = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      if (received !== null) {
        deps.log("[host-run] second interrupt: disconnecting; the remote Mac stops the job when the connection drops");
        stopSsh();
        return;
      }
      received = signal;
      deps.log(`[host-run] ${signal}: stopping the ${lane} run on ${config.forwardTo}`);
      onCancel();
      grace = setTimeout(stopSsh, cancelGraceMilliseconds);
    };
    const signals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
    for (const signal of signals) process.on(signal, onSignal);
    const deadline = setTimeout(() => {
      deps.log(`[host-run] forwarded run exceeded ${Math.round(deadlineMs / 60_000)} min; stopping it`);
      onCancel();
      grace = setTimeout(stopSsh, cancelGraceMilliseconds);
    }, deadlineMs);
    const finish = (): void => {
      for (const signal of signals) process.off(signal, onSignal);
      clearTimeout(deadline);
      if (grace !== undefined) clearTimeout(grace);
    };
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("exit", (code) => {
      finish();
      resolveRun({ exitCode: code, signal: received });
    });
  });
}

function fetchArtifacts(
  deps: ForwardDependencies,
  config: RemoteForwardConfig,
  script: string,
  id: string,
  artifacts: readonly string[],
  root: string,
  scratch: string,
): void {
  const archive = join(scratch, "artifacts.tar");
  const [program, ...rest] = sshCommand(config.forwardTo, script, "fetch", [id, ...artifacts]);
  const output = openSync(archive, "w");
  let result;
  try {
    result = spawnSync(program!, rest, {
      env: { ...deps.environment },
      stdio: ["ignore", output, "pipe"],
      timeout: 30 * 60_000,
    });
  } finally {
    closeSync(output);
  }
  const stderr = result.stderr?.toString("utf8") ?? "";
  if (stderr.trim() !== "") process.stderr.write(stderr);
  if (result.status === 3) {
    deps.log("[host-run] no declared artifacts were produced");
    return;
  }
  if (result.status !== 0) {
    deps.log(`[host-run] could not copy artifacts back from ${config.forwardTo} (exit ${result.status ?? "timeout"})`);
    return;
  }
  const extracted = deps.run(["tar", "-xf", archive, "-C", root], { timeoutMs: 30 * 60_000 });
  if (extracted.status !== 0) {
    deps.log(`[host-run] could not unpack artifacts: ${lastLines(extracted.stderr)}`);
    return;
  }
  deps.log(`[host-run] copied artifacts into ${root}: ${artifacts.join(", ")}`);
}

/**
 * Forwards one mac-ui run. Throws ForwardUnavailableError before anything
 * runs when the remote Mac or its clone is unavailable; never runs locally.
 */
export async function forwardMacUiRun(
  request: ForwardRequest,
  config: RemoteForwardConfig,
  deps: ForwardDependencies = defaultForwardDependencies(),
): Promise<number> {
  if (deps.environment.LOCAL_EFFICIENCY_FORWARDED === "1") {
    throw new ForwardUnavailableError(
      "this run was already forwarded here from another Mac; refusing to forward it again."
      + ` Remove ${config.source} on this host so it runs mac-ui work locally`,
    );
  }
  if (!existsSync(remoteScriptPath)) {
    throw new ForwardUnavailableError("mac-ui-remote.sh is missing; restore the local-efficiency installation");
  }
  const script = readFileSync(remoteScriptPath, "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "host-run-forward-"));
  const id = newForwardId();
  let started = false;
  try {
    const plan = planOrSeed(deps, config, script, request.cwd);
    const payload = buildPayload(deps, plan, scratch);
    const launcher = deps.environment.LOCAL_EFFICIENCY_REMOTE_LAUNCHER === "direct" ? "direct" : "launchd";
    const deadlineMs = forwardDeadlineMilliseconds(request.maxHoldMilliseconds);
    deps.log(
      `[host-run] forwarding ${request.mode} mac-ui ${request.label} to ${config.forwardTo}`
      + ` (${plan.local.head.slice(0, 12)}${plan.bundleNeeded ? " + bundle" : ""}, clone ${plan.remoteRepository}, run ${id});`
      + " no local lease is held while it runs",
    );
    started = true;
    const result = await streamRemoteRun(
      deps,
      config,
      script,
      [
        id,
        plan.remoteRepository,
        plan.local.head,
        plan.local.prefix,
        launcher,
        request.artifacts.length > 0 ? "1" : "0",
        String(Math.ceil(deadlineMs / 1_000)),
        config.remoteHostRun,
        "--",
        ...remoteHostRunArguments(request),
      ],
      payload,
      deadlineMs,
      () => {
        const cancel = remoteCall(deps, config, script, "cancel", [id], 30_000);
        if (cancel.status !== 0) deps.log(`[host-run] could not reach ${config.forwardTo} to stop the run`);
      },
    );
    if (result.exitCode === 255) {
      deps.log(`[host-run] ssh to ${config.forwardTo} failed or the remote command exited 255`);
    }
    if (request.artifacts.length > 0 && result.signal === null && result.exitCode !== null && result.exitCode !== 255) {
      fetchArtifacts(deps, config, script, id, request.artifacts, plan.local.root, scratch);
    }
    if (result.exitCode !== null) return result.exitCode;
    return signalExitCode(result.signal ?? "SIGTERM");
  } finally {
    if (started) {
      const cleanup = remoteCall(deps, config, script, "cleanup", [id], 60_000);
      if (cleanup.status !== 0) {
        deps.log(`[host-run] could not confirm cleanup of run ${id} on ${config.forwardTo}; it removes runs older than a day itself`);
      }
    }
    rmSync(scratch, { force: true, recursive: true });
  }
}
