/**
 * Heavy compute forwarding. On a workstation whose remote.json has a
 * `compute` entry, `host-run --lane=compute --mode=heavy|exclusive` ships the
 * current commit and uncommitted changes to the named Mac (the same transport
 * as mac-ui forwarding), runs the command there under that host's own
 * `host-run --lane=compute` at the same mode, streams the output back and
 * returns the remote exit code.
 *
 * Unlike mac-ui, compute may always run here, so anything that stops the
 * forward before the command starts (no repository, ssh down, a dirty
 * submodule, a workspace that cannot be prepared) falls back to a local run
 * with one line saying why. Once the command has started on the remote, its
 * exit code is the answer: a real build failure is never rerun locally.
 *
 * The remote keeps a small pool of cached workspaces per repository under
 * ~/.local/state/host-run/compute: each run resets one to the forwarded
 * commit plus patch and keeps ignored build output (target/, .build/,
 * node_modules/ ...) so warm builds stay incremental.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPayload,
  type ComputeForwardConfig,
  defaultForwardDependencies,
  type ForwardDependencies,
  forwardDeadlineMilliseconds,
  ForwardUnavailableError,
  git,
  lastLines,
  newForwardId,
  planOrSeed,
  remoteCall,
  remoteHostRunArguments,
  remoteScriptPath,
  repositoryKey,
  signalExitCode,
  streamRemoteRun,
} from "./mac-ui-forward";

export type ComputeForwardRequest = {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly label: string;
  readonly maxHoldMilliseconds?: number | null;
  readonly mode: "heavy" | "exclusive";
};

export type ComputeForwardOutcome =
  | { readonly ran: true; readonly exitCode: number }
  | { readonly ran: false; readonly reason: string };

/** Variables forwarded by exact name when set. */
export const forwardedEnvironmentNames: readonly string[] = Object.freeze([
  "CI",
  "CMAKE_BUILD_PARALLEL_LEVEL",
  "FORCE_COLOR",
  "HRA_JOBS",
  "LANG",
  "LC_ALL",
  "MAKEFLAGS",
  "NO_COLOR",
  "NODE_ENV",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "RUST_MIN_STACK",
  "RUST_TEST_THREADS",
  "RUSTDOCFLAGS",
  "RUSTFLAGS",
  "TZ",
]);

/** Variables forwarded by prefix when set. */
export const forwardedEnvironmentPrefixes: readonly string[] = Object.freeze(["CARGO_"]);

const secretName = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API_?KEY|PRIVATE|COOKIE|SESSION/iu;

/**
 * The small allowlist of build settings sent to the remote as `env NAME=VALUE`.
 * Names that look like secrets are never sent, and neither are values that
 * name a path on this Mac (CARGO_TARGET_DIR, CARGO_HOME ...): they would point
 * nowhere on the remote. Returns what is sent and what stays behind.
 */
export function forwardedEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  userHome = homedir(),
): { readonly assignments: readonly string[]; readonly kept: readonly string[] } {
  const assignments: string[] = [];
  const kept: string[] = [];
  for (const name of Object.keys(environment).sort()) {
    const value = environment[name];
    if (value === undefined) continue;
    const listed = forwardedEnvironmentNames.includes(name)
      || forwardedEnvironmentPrefixes.some((prefix) => name.startsWith(prefix));
    if (!listed) continue;
    if (
      secretName.test(name)
      || !/^[A-Z_][A-Z0-9_]*$/u.test(name)
      || /[\0-\x1f\x7f]/u.test(value)
      || value.startsWith("/")
      || value.startsWith("~")
      || (userHome !== "" && value.includes(userHome))
    ) {
      kept.push(name);
      continue;
    }
    assignments.push(`${name}=${value}`);
  }
  return { assignments, kept };
}

/** Refuses (so the run stays local) when a submodule has changes the remote cannot see. */
export function assertCleanSubmodules(deps: ForwardDependencies, root: string): void {
  if (!existsSync(join(root, ".gitmodules"))) return;
  const status = git(deps, root, ["submodule", "status", "--recursive"]);
  if (status.status !== 0) {
    throw new ForwardUnavailableError(`could not read submodule status: ${lastLines(status.stderr)}`);
  }
  const moved = status.stdout.toString("utf8").split("\n").filter((line) => /^[+U-]/u.test(line));
  const dirty = git(deps, root, ["status", "--porcelain=v1", "--ignore-submodules=none", "--", "."]);
  const paths = status.stdout.toString("utf8").split("\n")
    .map((line) => line.slice(1).trim().split(/\s+/u)[1])
    .filter((path): path is string => path !== undefined && path !== "");
  const changed = dirty.status === 0
    ? dirty.stdout.toString("utf8").split("\n").map((line) => line.slice(3)).filter((path) => paths.includes(path))
    : [];
  if (moved.length > 0 || changed.length > 0) {
    const names = [...new Set([...moved.map((line) => line.slice(1).trim().split(/\s+/u)[1] ?? ""), ...changed])].filter(Boolean);
    throw new ForwardUnavailableError(`submodule ${names.join(", ")} has changes or commits the remote cannot check out`);
  }
}

function localVersions(deps: ForwardDependencies): { readonly macos: string; readonly xcode: string } {
  const read = (argv: readonly string[]): string => {
    const result = deps.run(argv, { env: { ...deps.environment }, timeoutMs: 15_000 });
    return result.status === 0 ? result.stdout.toString("utf8").split("\n")[0]!.trim() : "";
  };
  return { macos: read(["sw_vers", "-productVersion"]), xcode: read(["xcodebuild", "-version"]) };
}

function parseCleanup(output: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) fields[line.slice(0, tab)] = line.slice(tab + 1).trim();
  }
  return fields;
}

/**
 * Forwards one heavy compute run, or reports why it has to run here.
 * Throws only for local errors that a local run would hit too.
 */
export async function forwardComputeRun(
  request: ComputeForwardRequest,
  config: ComputeForwardConfig,
  deps: ForwardDependencies = defaultForwardDependencies(),
): Promise<ComputeForwardOutcome> {
  if (!existsSync(remoteScriptPath)) return { ran: false, reason: "mac-ui-remote.sh is missing from this installation" };
  const script = readFileSync(remoteScriptPath, "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "host-run-compute-"));
  const id = newForwardId();
  let started = false;
  try {
    let plan;
    let payload;
    try {
      plan = planOrSeed(deps, config, script, request.cwd, "compute");
      assertCleanSubmodules(deps, plan.local.root);
      payload = buildPayload(deps, plan, scratch, config);
    } catch (error: unknown) {
      if (error instanceof ForwardUnavailableError) return { ran: false, reason: error.message };
      throw error;
    }
    const environment = forwardedEnvironment(deps.environment);
    const command = environment.assignments.length > 0
      ? ["env", ...environment.assignments, ...request.command]
      : request.command;
    const deadlineMs = forwardDeadlineMilliseconds(request.maxHoldMilliseconds);
    const sentNames = environment.assignments.map((assignment) => assignment.slice(0, assignment.indexOf("=")));
    deps.log(
      `[host-run] forwarding ${request.mode} compute ${request.label} to ${config.forwardTo}`
      + ` (${plan.local.head.slice(0, 12)}${plan.bundleNeeded ? " + bundle" : ""}, run ${id}`
      + `${sentNames.length > 0 ? `, env ${sentNames.join(" ")}` : ""}`
      + `${environment.kept.length > 0 ? `, not sent: ${environment.kept.join(" ")}` : ""});`
      + " pass --local to run here",
    );
    started = true;
    const startedAt = Date.now();
    const result = await streamRemoteRun(
      deps,
      config,
      script,
      [
        id,
        plan.remoteRepository,
        plan.local.head,
        plan.local.prefix,
        repositoryKey(plan.local.origin),
        String(config.slots),
        String(config.cacheGiB),
        String(config.minFreeGiB),
        String(Math.ceil(deadlineMs / 1_000)),
        config.remoteHostRun,
        "--",
        ...remoteHostRunArguments({ ...request, artifacts: [], command }, "compute"),
      ],
      payload,
      deadlineMs,
      () => {
        const cancel = remoteCall(deps, config, script, "cancel", [id], 30_000);
        if (cancel.status !== 0) deps.log(`[host-run] could not reach ${config.forwardTo} to stop the run`);
      },
      "compute",
    );
    const failed = result.signal === null && result.exitCode !== 0;
    const cleanup = remoteCall(deps, config, script, "cleanup", failed ? [id, "versions"] : [id], 60_000);
    started = false;
    const fields = cleanup.status === 0 ? parseCleanup(cleanup.stdout.toString("utf8")) : {};
    if (cleanup.status !== 0) {
      deps.log(`[host-run] could not confirm cleanup of run ${id} on ${config.forwardTo}; it removes runs older than a day itself`);
    }
    if (result.signal !== null) return { ran: true, exitCode: signalExitCode(result.signal) };
    // "gone": the remote never created the run directory, so nothing started.
    if (fields.state === "not-started" || fields.state === "gone") {
      return { ran: false, reason: `${config.forwardTo} could not prepare the run: ${fields.reason ?? `exit ${result.exitCode ?? "unknown"}`}` };
    }
    const exitCode = result.exitCode ?? signalExitCode("SIGTERM");
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    if (exitCode === 0) {
      deps.log(`[host-run] ${request.label} finished on ${config.forwardTo} in ${seconds}s`);
    } else {
      deps.log(`[host-run] ${request.label} exited ${exitCode} on ${config.forwardTo} after ${seconds}s; not rerunning it here`);
      if (exitCode === 255) deps.log(`[host-run] ssh to ${config.forwardTo} failed or the remote command exited 255`);
      const here = localVersions(deps);
      const there = { macos: fields.macos ?? "", xcode: fields.xcode ?? "" };
      if ((there.macos !== "" && there.macos !== here.macos) || (there.xcode !== "" && there.xcode !== here.xcode)) {
        deps.log(
          `[host-run] toolchains differ: ${config.forwardTo} has macOS ${there.macos || "?"}, ${there.xcode || "no Xcode"};`
          + ` this Mac has macOS ${here.macos || "?"}, ${here.xcode || "no Xcode"}.`
          + " If the failure looks like an SDK or compiler difference, rerun with --local",
        );
      }
    }
    return { ran: true, exitCode };
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
