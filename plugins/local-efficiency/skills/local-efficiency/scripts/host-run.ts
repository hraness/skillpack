#!/usr/bin/env bun

import { spawn } from "node:child_process";
import {
  existsSync,
  fstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, constants as osConstants, homedir } from "node:os";
import { delimiter as pathDelimiter, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { isChromeLauncher, validateChromeExecutable } from "./chrome-launcher";

import {
  commandProgramLabel,
  containsControlCharacters,
  requireOperationLabel,
  sha256,
} from "./shared";
import {
  type ThroughputOutcome,
  appendThroughputEvent,
  commandDigest,
  newThroughputEvent,
  scopeDigest,
  throughputTelemetryRoot,
} from "./telemetry";

export type ResourceMode = "shared" | "heavy" | "exclusive";
export type CapabilityLane = "compute" | "browser" | "browser-auth" | "mac-native";

export const capabilityLanes: readonly CapabilityLane[] = [
  "compute",
  "browser",
  "browser-auth",
  "mac-native",
];

export function isCapabilityLane(value: unknown): value is CapabilityLane {
  return value === "compute" || value === "browser" || value === "browser-auth"
    || value === "mac-native";
}

/** Capability profile. v2 adds the headless `browser` lane (4 slots). */
export const capabilityProfile = Object.freeze({
  id: "local-efficiency/capabilities-v2",
  capacities: Object.freeze([
    Object.freeze({ resource: "browser", limit: 4 }),
    Object.freeze({ resource: "browser-auth", limit: 1 }),
    Object.freeze({ resource: "mac-native", limit: 1 }),
  ]),
});

/** The v1 profile, still accepted for leases inherited from an older outer wrapper. */
export const legacyCapabilityProfile = Object.freeze({
  id: "local-efficiency/capabilities-v1",
  capacities: Object.freeze([
    Object.freeze({ resource: "browser-auth", limit: 1 }),
    Object.freeze({ resource: "mac-native", limit: 1 }),
  ]),
});

/** Total queue wait (capability + CPU) before host-run gives up. */
export const queueTimeoutMilliseconds = 2 * 60 * 60_000;
export const queueTimeoutExitCode = 75;
export const holdTimeoutExitCode = 124;
const minuteMilliseconds = 60_000;

/**
 * Default wall-clock cap for an admitted lease, by lane and mode. The smallest
 * applicable default wins; compute shared/heavy runs have no default cap.
 */
export function defaultMaxHoldMilliseconds(
  lane: CapabilityLane,
  mode: ResourceMode,
): number | null {
  const candidates: number[] = [];
  if (mode === "exclusive") candidates.push(60 * minuteMilliseconds);
  if (lane === "browser") candidates.push(20 * minuteMilliseconds);
  if (lane === "browser-auth") candidates.push(45 * minuteMilliseconds);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** Parses `90s`, `20m`, `1.5h`, `500ms`, a bare minute count, or `none`. */
export function parseDuration(value: string): number | null {
  if (value === "none") return null;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u.exec(value);
  if (match === null) throw new Error(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "m";
  const scale = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? minuteMilliseconds : 60 * minuteMilliseconds;
  const milliseconds = Math.round(amount * scale);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error(`invalid duration: ${value}`);
  }
  return milliseconds;
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export const hostAccessRequiredCode = "HOST_ACCESS_REQUIRED";
export const hostAccessRequiredExitCode = 77;

export class HostAccessRequiredError extends Error {
  readonly code = hostAccessRequiredCode;

  constructor() {
    super(
      "the machine-wide scheduler state is outside the active permission boundary; "
      + "retry this identical host-run invocation through reviewed host access, "
      + "without running the child directly or removing scheduler state",
    );
    this.name = "HostAccessRequiredError";
  }
}

type HostResourceLease = {
  readonly inheritedFileDescriptor: number;
};

type HostResourceCoordinator = {
  withLease<T>(
    claims: readonly { readonly resource: string; readonly amount: number }[],
    callback: (lease: HostResourceLease) => T | Promise<T>,
    options?: {
      readonly signal?: AbortSignal;
      readonly waitTimeoutMilliseconds?: number;
    },
  ): Promise<T>;
};

type HostResourceModule = {
  createHostResourceCoordinator(options: {
    readonly profile: {
      readonly id: string;
      readonly capacities: readonly { readonly resource: string; readonly limit: number }[];
    };
    readonly stateRoot: string;
    readonly waitTimeoutMilliseconds: number;
  }): HostResourceCoordinator;
};

export type HostRunOptions = {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly label: string;
  readonly lane: CapabilityLane;
  /** Wall-clock cap after admission; `null` disables it, `undefined` uses the lane default. */
  readonly maxHoldMilliseconds?: number | null;
  readonly mode: ResourceMode;
  readonly stateRoot?: string;
};

export function permitCapacity(hostParallelism = availableParallelism()): number {
  if (hostParallelism >= 12) return 4;
  if (hostParallelism >= 6) return 3;
  if (hostParallelism >= 3) return 2;
  return 1;
}

export function permitsForMode(
  mode: ResourceMode,
  hostParallelism = availableParallelism(),
  lane: CapabilityLane = "compute",
): number {
  return expectedPermits(mode, permitCapacity(hostParallelism), lane);
}

/**
 * Child job-width defaults derived from the lease: permits x cores / capacity.
 * Only variables the caller left unset are returned. `RUSTC_WRAPPER=sccache` is
 * added only when sccache is already on PATH; nothing is installed.
 */
export function jobEnvironment(
  permits: number,
  capacity: number,
  environment: Readonly<NodeJS.ProcessEnv>,
  hostParallelism = availableParallelism(),
): Record<string, string> {
  const jobs = Math.max(1, Math.floor((permits * hostParallelism) / Math.max(1, capacity)));
  const defaults: Record<string, string> = {
    CARGO_BUILD_JOBS: String(jobs),
    HRA_JOBS: String(jobs),
    MAKEFLAGS: `-j${jobs}`,
    NEXTEST_TEST_THREADS: String(jobs),
    RAYON_NUM_THREADS: String(jobs),
  };
  const additions: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (environment[key] === undefined || environment[key] === "") additions[key] = value;
  }
  if (
    (environment.RUSTC_WRAPPER === undefined || environment.RUSTC_WRAPPER === "")
    && findOnPath("sccache", environment) !== null
  ) additions.RUSTC_WRAPPER = "sccache";
  return additions;
}

export function findOnPath(
  program: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string | null {
  for (const directory of (environment.PATH ?? "").split(pathDelimiter)) {
    if (directory === "" || !isAbsolute(directory)) continue;
    const candidate = join(directory, program);
    try {
      const metadata = statSync(candidate);
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) return candidate;
    } catch {
      // not on this PATH entry
    }
  }
  return null;
}

/** The Chrome launcher that merges `MacAppCodeSignClone` into one `--disable-features`. */
export function chromeLauncherPath(): string {
  return join(import.meta.dir, "hra-chrome");
}

/**
 * On macOS, route agent-browser through hra-chrome while retaining the caller's
 * selected executable. The launcher reads agent-browser config at launch time
 * when no explicit executable was supplied, so compute jobs need no browser.
 */
export function chromeEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
  launcher = chromeLauncherPath(),
  cwd = process.cwd(),
): Record<string, string> {
  if (platform !== "darwin") return {};
  if (!existsSync(launcher)) throw new Error("hra-chrome launcher unavailable; restore the local-efficiency installation before launching a browser");
  const additions: Record<string, string> = {};
  if (environment.HRA_CHROME === undefined || environment.HRA_CHROME === "") {
    additions.HRA_CHROME = launcher;
  } else if (!isChromeLauncher(environment.HRA_CHROME, launcher, cwd)) {
    validateChromeExecutable(environment.HRA_CHROME, cwd);
  }
  const selected = environment.AGENT_BROWSER_EXECUTABLE_PATH;
  if (selected !== undefined && selected !== "" && !isChromeLauncher(selected, launcher, cwd)) {
    // Keep explicit selection ahead of config, with the same mandatory flags.
    additions.HRA_CHROME_REAL = validateChromeExecutable(selected, cwd, launcher);
  } else if (environment.HRA_CHROME_REAL !== undefined && environment.HRA_CHROME_REAL !== "") {
    validateChromeExecutable(environment.HRA_CHROME_REAL, cwd, launcher);
  }
  if (selected !== launcher) additions.AGENT_BROWSER_EXECUTABLE_PATH = launcher;
  return additions;
}

export function parseHostRunArguments(arguments_: readonly string[]): {
  readonly command: readonly string[];
  readonly label: string;
  readonly lane: CapabilityLane;
  readonly maxHoldMilliseconds?: number | null;
  readonly mode: ResourceMode;
} {
  const delimiter = arguments_.indexOf("--");
  if (delimiter < 0) throw new Error("host-run requires -- before its command");
  let label: string | undefined;
  let lane: CapabilityLane = "compute";
  let laneSupplied = false;
  let mode: ResourceMode | undefined;
  let maxHold: number | null | undefined;
  let maxHoldSupplied = false;
  for (const argument of arguments_.slice(0, delimiter)) {
    if (argument.startsWith("--max-hold=")) {
      if (maxHoldSupplied) throw new Error("--max-hold may appear only once");
      maxHold = parseDuration(argument.slice("--max-hold=".length));
      maxHoldSupplied = true;
      continue;
    }
    if (argument.startsWith("--mode=")) {
      if (mode !== undefined) throw new Error("--mode may appear only once");
      const value = argument.slice("--mode=".length);
      if (value !== "shared" && value !== "heavy" && value !== "exclusive") {
        throw new Error(`invalid resource mode: ${value}`);
      }
      mode = value;
      continue;
    }
    if (argument.startsWith("--label=")) {
      if (label !== undefined) throw new Error("--label may appear only once");
      label = requireOperationLabel(argument.slice("--label=".length), "--label");
      continue;
    }
    if (argument.startsWith("--lane=")) {
      if (laneSupplied) throw new Error("--lane may appear only once");
      const value = argument.slice("--lane=".length);
      if (!isCapabilityLane(value)) {
        throw new Error(`invalid capability lane: ${value}`);
      }
      lane = value;
      laneSupplied = true;
      continue;
    }
    throw new Error(`unknown host-run argument: ${argument}`);
  }
  const command = arguments_.slice(delimiter + 1);
  if (command.length === 0 || command[0] === undefined || command[0] === "") {
    throw new Error("host-run requires a command");
  }
  if (containsControlCharacters(command[0])) {
    throw new Error("command program must contain no control characters");
  }
  return {
    command,
    label: label ?? commandProgramLabel(command[0]),
    lane,
    ...(maxHoldSupplied ? { maxHoldMilliseconds: maxHold ?? null } : {}),
    mode: mode ?? "shared",
  };
}

export function resolveHostResourceStateRoot(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.LOCAL_EFFICIENCY_STATE_ROOT;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) {
      throw new Error("LOCAL_EFFICIENCY_STATE_ROOT must be absolute");
    }
    return resolve(configured);
  }
  const xdgState = environment.XDG_STATE_HOME;
  if (xdgState !== undefined && xdgState !== "") {
    if (!isAbsolute(xdgState)) throw new Error("XDG_STATE_HOME must be absolute");
    return join(resolve(xdgState), "local-efficiency", "host-resources-v1");
  }
  return join(resolve(userHome), ".local", "state", "local-efficiency", "host-resources-v1");
}

export function resolveCapabilityStateRoot(hostResourceStateRoot: string): string {
  return join(resolve(hostResourceStateRoot, ".."), "capabilities-v2");
}

export function resolveHolderRoot(hostResourceStateRoot: string): string {
  return join(resolve(hostResourceStateRoot, ".."), "holders-v1");
}

export function resolveAtetRuntimeRoot(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.LOCAL_EFFICIENCY_RUNTIME_ROOT;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) throw new Error("LOCAL_EFFICIENCY_RUNTIME_ROOT must be absolute");
    return resolve(configured);
  }
  const xdgData = environment.XDG_DATA_HOME;
  if (xdgData !== undefined && xdgData !== "") {
    if (!isAbsolute(xdgData)) throw new Error("XDG_DATA_HOME must be absolute");
    return join(resolve(xdgData), "local-efficiency", "runtime", "atet-v2.0.0");
  }
  return join(resolve(userHome), ".local", "share", "local-efficiency", "runtime", "atet-v2.0.0");
}

function atetCandidates(
  environment: Readonly<NodeJS.ProcessEnv>,
  userHome = homedir(),
): string[] {
  const configured = environment.ATET_HOST_RESOURCES_MODULE;
  return [
    ...(configured === undefined || configured === "" ? [] : [configured]),
    join(resolveAtetRuntimeRoot(environment, userHome), "host-resources.js"),
  ].map((candidate) => resolve(candidate));
}

export function resolveAtetHostResourceModule(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const path = atetCandidates(environment, userHome)
    .find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new Error(
      "the private Atet host-resource runtime is unavailable; run the local-efficiency bootstrap",
    );
  }
  return path;
}

async function hostResourceModule(
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<HostResourceModule> {
  const loaded: unknown = await import(pathToFileURL(resolveAtetHostResourceModule(environment)).href);
  if (
    typeof loaded !== "object"
    || loaded === null
    || !("createHostResourceCoordinator" in loaded)
    || typeof loaded.createHostResourceCoordinator !== "function"
  ) {
    throw new Error("the installed Atet host-resource module is incompatible");
  }
  return { createHostResourceCoordinator: loaded.createHostResourceCoordinator as HostResourceModule["createHostResourceCoordinator"] };
}

export type HoldLimit = {
  readonly label: string;
  readonly maxHoldMilliseconds: number;
};

type SpawnResult = { readonly exitCode: number; readonly holdTimedOut: boolean };

/** Grace between TERM and KILL when a lease exceeds its max hold. */
export function holdGraceMilliseconds(maxHoldMilliseconds: number): number {
  return Math.min(10_000, Math.max(250, Math.round(maxHoldMilliseconds * 0.1)));
}

function spawnCommand(
  command: readonly string[],
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  inheritedLeaseDescriptors: readonly number[] = [],
  hold: HoldLimit | null = null,
): Promise<SpawnResult> {
  return new Promise((resolveExit, reject) => {
    const [program, ...arguments_] = command;
    if (program === undefined) return reject(new Error("command is empty"));
    const ownsProcessGroup = process.platform !== "win32" && !process.stdin.isTTY;
    const child = spawn(program, arguments_, {
      cwd,
      detached: ownsProcessGroup,
      env: { ...environment },
      stdio: inheritedLeaseDescriptors.length === 0
        ? "inherit"
        : ["inherit", "inherit", "inherit", ...inheritedLeaseDescriptors],
    });
    let forcedCleanup: ReturnType<typeof setTimeout> | undefined;
    const signalChildTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (ownsProcessGroup) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error: unknown) {
        if (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ESRCH"
        ) return;
        try {
          child.kill(signal);
        } catch {
          console.error("[host-run] could not forward signal to the complete child tree");
        }
      }
    };
    const processGroupExists = (): boolean => {
      if (!ownsProcessGroup || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error: unknown) {
        if (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ESRCH"
        ) return false;
        return true;
      }
    };
    const forward = (signal: NodeJS.Signals): void => {
      signalChildTree(signal);
      if (ownsProcessGroup && forcedCleanup === undefined) {
        forcedCleanup = setTimeout(() => signalChildTree("SIGKILL"), 750);
      }
    };
    const forwardedSignals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
    for (const signal of forwardedSignals) process.on(signal, forward);
    const holdTimers: ReturnType<typeof setTimeout>[] = [];
    let holdTimedOut = false;
    if (hold !== null) {
      const limit = formatDuration(hold.maxHoldMilliseconds);
      holdTimers.push(setTimeout(() => {
        console.error(
          `[host-run] ${hold.label} has used 80% of its ${limit} max hold;`
          + " it will be terminated at the limit (override with --max-hold=DURATION or --max-hold=none)",
        );
      }, Math.round(hold.maxHoldMilliseconds * 0.8)));
      holdTimers.push(setTimeout(() => {
        holdTimedOut = true;
        console.error(
          `[host-run] ${hold.label} exceeded its ${limit} max hold; sending TERM to the leased command`,
        );
        signalChildTree("SIGTERM");
        holdTimers.push(setTimeout(() => {
          console.error(`[host-run] ${hold.label} ignored TERM; sending KILL to the leased command`);
          signalChildTree("SIGKILL");
        }, holdGraceMilliseconds(hold.maxHoldMilliseconds)));
      }, hold.maxHoldMilliseconds));
    }
    const removeSignalHandlers = (): void => {
      for (const signal of forwardedSignals) process.off(signal, forward);
      for (const timer of holdTimers) clearTimeout(timer);
    };
    child.once("error", (error) => {
      removeSignalHandlers();
      if (forcedCleanup !== undefined) clearTimeout(forcedCleanup);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      removeSignalHandlers();
      if (forcedCleanup !== undefined) clearTimeout(forcedCleanup);
      void (async () => {
        if (processGroupExists()) {
          signalChildTree("SIGTERM");
          for (let attempt = 0; attempt < 10 && processGroupExists(); attempt += 1) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
          }
          if (processGroupExists()) signalChildTree("SIGKILL");
        }
        resolveExit({
          exitCode: holdTimedOut
            ? holdTimeoutExitCode
            : code ?? (signal === null ? 1 : signalExitCode(signal)),
          holdTimedOut,
        });
      })().catch(reject);
    });
  });
}

type InheritedLease = {
  readonly capacity: number;
  readonly lane: CapabilityLane;
  readonly mode: ResourceMode;
  readonly permits: number;
};

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parsedLeaseMode(value: unknown): ResourceMode | null {
  return value === "shared" || value === "heavy" || value === "exclusive" ? value : null;
}

function parsedLeaseCapacity(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 4
    ? Number(value)
    : null;
}

/**
 * Weighted CPU permits: shared 1, heavy 2, exclusive all. Exclusive on a
 * capability lane (browser, browser-auth, mac-native) means exclusive use of
 * that capability and is capped at 2 CPU permits; only the compute lane takes
 * the whole machine.
 */
export function expectedPermits(
  mode: ResourceMode,
  capacity: number,
  lane: CapabilityLane = "compute",
): number {
  if (mode === "shared") return 1;
  if (mode === "heavy") return Math.min(2, capacity);
  return lane === "compute" ? capacity : Math.min(2, capacity);
}

function legacyExclusivePermits(
  mode: ResourceMode,
  capacity: number,
  lane: CapabilityLane,
  permits: unknown,
): boolean {
  // An outer wrapper started before capabilities-v2 took every permit for a
  // capability-lane exclusive run; keep honouring its nested calls.
  return mode === "exclusive" && lane !== "compute" && lane !== "browser" && permits === capacity;
}

export function parseInheritedLease(value: string): InheritedLease {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("inherited local-efficiency lease is malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("inherited local-efficiency lease is malformed");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version === 1) {
    if (!hasExactKeys(record, ["capacity", "label", "mode", "permits", "version"])) {
      throw new Error("inherited local-efficiency lease is malformed");
    }
    const capacity = parsedLeaseCapacity(record.capacity);
    const mode = parsedLeaseMode(record.mode);
    if (
      capacity === null
      || mode === null
      || record.permits !== expectedPermits(mode, capacity)
      || typeof record.label !== "string"
    ) throw new Error("inherited local-efficiency lease is malformed");
    requireOperationLabel(record.label, "inherited lease label");
    return { capacity, lane: "compute", mode, permits: record.permits };
  }
  if (
    !hasExactKeys(record, ["capacity", "label", "lane", "mode", "permits", "version"])
    || record.version !== 2
    || !isCapabilityLane(record.lane)
    || parsedLeaseMode(record.mode) === null
    || parsedLeaseCapacity(record.capacity) === null
    || typeof record.label !== "string"
  ) throw new Error("inherited local-efficiency lease is malformed");
  const capacity = parsedLeaseCapacity(record.capacity);
  const mode = parsedLeaseMode(record.mode);
  const lane = record.lane as CapabilityLane;
  if (
    capacity === null
    || mode === null
    || (
      record.permits !== expectedPermits(mode, capacity, lane)
      && !legacyExclusivePermits(mode, capacity, lane, record.permits)
    )
  ) throw new Error("inherited local-efficiency lease is malformed");
  requireOperationLabel(record.label, "inherited lease label");
  return { capacity, lane, mode, permits: Number(record.permits) };
}

type InheritedMarker = {
  readonly claims: readonly { readonly amount: number; readonly resource: string }[];
  readonly owner: string;
  readonly phase: "A";
  readonly profileSha256: string;
  readonly ticket: string;
  readonly version: 1;
};

function inheritedMarker(descriptor: number): InheritedMarker {
  let metadata;
  try {
    metadata = fstatSync(descriptor);
  } catch {
    throw new Error("inherited local-efficiency lease descriptor is unavailable");
  }
  const owned = process.getuid === undefined || metadata.uid === process.getuid();
  if (
    !metadata.isFile()
    || metadata.nlink !== 1
    || !owned
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size < 1
    || metadata.size > 4_096
  ) throw new Error("inherited local-efficiency lease descriptor is invalid");
  const bytes = Buffer.alloc(metadata.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== bytes.length) {
    throw new Error("inherited local-efficiency lease descriptor is incomplete");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("inherited local-efficiency lease descriptor is malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("inherited local-efficiency lease descriptor is malformed");
  }
  const record = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["claims", "owner", "phase", "profileSha256", "ticket", "version"])
    || record.version !== 1
    || record.phase !== "A"
    || typeof record.owner !== "string"
    || !/^[0-9a-f]{32}$/u.test(record.owner)
    || typeof record.ticket !== "string"
    || !/^[1-9][0-9]{0,19}$/u.test(record.ticket)
    || typeof record.profileSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.profileSha256)
    || !Array.isArray(record.claims)
  ) throw new Error("inherited local-efficiency lease descriptor is malformed");
  return parsed as InheritedMarker;
}

function expectedProfileDigest(profile: {
  readonly capacities: readonly { readonly limit: number; readonly resource: string }[];
  readonly id: string;
}): string {
  return sha256(JSON.stringify(profile));
}

function assertMarker(
  descriptor: number,
  profileDigests: readonly string[],
  claims: readonly { readonly amount: number; readonly resource: string }[],
): void {
  const marker = inheritedMarker(descriptor);
  if (
    !profileDigests.includes(marker.profileSha256)
    || JSON.stringify(marker.claims) !== JSON.stringify(claims)
  ) throw new Error("inherited local-efficiency lease descriptor does not cover this request");
}

function assertInheritedLeaseDescriptors(inherited: InheritedLease): void {
  if (inherited.capacity !== permitCapacity()) {
    throw new Error("inherited local-efficiency lease capacity changed");
  }
  let descriptor = 3;
  if (inherited.lane !== "compute") {
    assertMarker(
      descriptor,
      inherited.lane === "browser"
        ? [expectedProfileDigest(capabilityProfile)]
        : [expectedProfileDigest(capabilityProfile), expectedProfileDigest(legacyCapabilityProfile)],
      [{ resource: inherited.lane, amount: 1 }],
    );
    descriptor += 1;
  }
  assertMarker(
    descriptor,
    [expectedProfileDigest({
      id: `local-efficiency/v1-${inherited.capacity}`,
      capacities: [{ resource: "cpu", limit: inherited.capacity }],
    })],
    [{ resource: "cpu", amount: inherited.permits }],
  );
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + osConstants.signals[signal];
}

function modeRank(mode: ResourceMode): number {
  if (mode === "shared") return 1;
  if (mode === "heavy") return 2;
  return 3;
}

export function inheritedLeaseCovers(
  inherited: InheritedLease,
  requested: Pick<HostRunOptions, "lane" | "mode">,
): boolean {
  // The signed-in browser owner may also drive headless browsers.
  const capabilityCovered = requested.lane === "compute"
    || inherited.lane === requested.lane
    || (requested.lane === "browser" && inherited.lane === "browser-auth");
  return capabilityCovered
    && modeRank(inherited.mode) >= modeRank(requested.mode)
    && expectedPermits(requested.mode, inherited.capacity, requested.lane) <= inherited.permits;
}

export function permissionBoundaryDenied(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return false;
    seen.add(current);
    if (
      "code" in current
      && (current.code === "EACCES" || current.code === "EPERM")
    ) return true;
    try {
      current = "cause" in current ? current.cause : undefined;
    } catch {
      return false;
    }
  }
  return false;
}

export function capabilityPlatformSupported(
  lane: CapabilityLane,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return lane !== "mac-native" || platform === "darwin";
}

export type HolderRecord = {
  readonly admittedAt: string;
  readonly label: string;
  readonly lane: CapabilityLane;
  readonly mode: ResourceMode;
  readonly permits: number;
  readonly pid: number;
  readonly version: 1;
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function holderFileName(pid: number, token: string): string {
  return `${pid}-${token}.json`;
}

/** Records who holds a lease so waiters can say what blocks them. Best effort. */
export function registerHolder(root: string, record: HolderRecord, token: string): string | null {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, holderFileName(record.pid, token));
    writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

export function releaseHolder(path: string | null): void {
  if (path === null) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Live holders only; records whose process is gone are ignored, never trusted. */
export function readHolders(root: string, alive: (pid: number) => boolean = processAlive): HolderRecord[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const holders: HolderRecord[] = [];
  for (const name of names.slice(0, 256)) {
    if (!/^[1-9][0-9]*-[0-9a-f]{8,64}\.json$/u.test(name)) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(root, name), "utf8")) as HolderRecord;
      if (
        parsed.version === 1
        && Number.isSafeInteger(parsed.pid)
        && typeof parsed.label === "string"
        && isCapabilityLane(parsed.lane)
        && alive(parsed.pid)
      ) holders.push(parsed);
    } catch {
      // unreadable or racing with release
    }
  }
  return holders.sort((left, right) => left.admittedAt.localeCompare(right.admittedAt));
}

/** One line naming the holders relevant to a waiting request. */
export function describeHolders(
  holders: readonly HolderRecord[],
  lane: CapabilityLane,
  now = new Date(),
): string {
  const relevant = holders.filter((holder) => lane === "compute" || holder.lane === lane);
  const shown = (relevant.length > 0 ? relevant : holders).slice(0, 4);
  if (shown.length === 0) return "held by an unregistered holder (started before holder tracking)";
  const parts = shown.map((holder) => {
    const age = formatDuration(now.getTime() - Date.parse(holder.admittedAt));
    return `${holder.label} (pid ${holder.pid}, ${holder.mode} ${holder.lane}, ${holder.permits} permits, held ${age})`;
  });
  const more = (relevant.length > 0 ? relevant : holders).length - shown.length;
  return `held by ${parts.join("; ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function waitTimedOut(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === "WAIT_TIMEOUT") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export class QueueTimeoutError extends Error {
  constructor(label: string, lane: CapabilityLane, waitedMilliseconds: number) {
    super(
      `${label} waited ${formatDuration(waitedMilliseconds)} for the ${lane} lane without admission;`
      + " gave up (queue timeout 2h). Check who holds the lane in the messages above",
    );
    this.name = "QueueTimeoutError";
  }
}

export async function runHostCommand(options: HostRunOptions): Promise<number> {
  const environment = { ...(options.environment ?? process.env) };
  if (!capabilityPlatformSupported(options.lane)) {
    throw new Error("the mac-native capability lane requires macOS");
  }
  const inheritedValue = environment.LOCAL_EFFICIENCY_LEASE;
  if (inheritedValue !== undefined) {
    const inherited = parseInheritedLease(inheritedValue);
    if (!inheritedLeaseCovers(inherited, options)) {
      throw new Error("nested host-run cannot escalate its outer mode or capability lane");
    }
    assertInheritedLeaseDescriptors(inherited);
    return (await spawnCommand(options.command, options.cwd, environment)).exitCode;
  }
  const capacity = permitCapacity();
  const permitCount = permitsForMode(options.mode, availableParallelism(), options.lane);
  const maxHold = options.maxHoldMilliseconds === undefined
    ? defaultMaxHoldMilliseconds(options.lane, options.mode)
    : options.maxHoldMilliseconds;
  const stateRoot = options.stateRoot
    ?? resolveHostResourceStateRoot(environment);
  const holderRoot = resolveHolderRoot(stateRoot);
  const queuedAtMonotonic = performance.now();
  const queuedAt = new Date();
  console.error(
    `[host-run] waiting for ${options.mode} ${options.lane} ${options.label}`
    + ` (${permitCount}/${capacity} permits`
    + `${maxHold === null ? "" : `, max hold ${formatDuration(maxHold)}`})`,
  );
  const execution: { admittedAt: Date | null; recorded: boolean; runStartedAt: number | null } = {
    admittedAt: null,
    recorded: false,
    runStartedAt: null,
  };
  const scope = scopeDigest(options.cwd);
  const digest = commandDigest(options.command, scope);
  const telemetryRoot = throughputTelemetryRoot(stateRoot);
  const record = (
    outcome: ThroughputOutcome,
    exitCode: number | null,
  ): void => {
    if (execution.recorded) return;
    execution.recorded = true;
    if (environment.LOCAL_EFFICIENCY_TELEMETRY === "off") return;
    const finishedAt = new Date();
    try {
      appendThroughputEvent(telemetryRoot, newThroughputEvent({
        admittedAt: execution.admittedAt?.toISOString() ?? null,
        capacity,
        capability: options.lane,
        commandDigest: digest,
        exitCode,
        finishedAt: finishedAt.toISOString(),
        label: options.label,
        mode: options.mode,
        outcome,
        permits: permitCount,
        program: commandProgramLabel(options.command[0] ?? "command"),
        queueMilliseconds: Math.max(0, Math.round(
          (execution.runStartedAt ?? performance.now()) - queuedAtMonotonic,
        )),
        queuedAt: queuedAt.toISOString(),
        runMilliseconds: execution.runStartedAt === null
          ? null
          : Math.max(0, Math.round(performance.now() - execution.runStartedAt)),
        scopeDigest: scope,
      }));
    } catch {
      console.error("[host-run] throughput telemetry unavailable");
    }
  };
  const cancellation = new AbortController();
  const cancellationState: { signal: NodeJS.Signals | null } = { signal: null };
  const cancel = (signal: NodeJS.Signals): void => {
    if (cancellationState.signal !== null) return;
    cancellationState.signal = signal;
    cancellation.abort();
    record("canceled", signalExitCode(signal));
  };
  const cancellationSignals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
  for (const signal of cancellationSignals) process.on(signal, cancel);
  const waitReportMilliseconds = Number(environment.LOCAL_EFFICIENCY_WAIT_REPORT_MS ?? 60_000);
  const waitReporter = setInterval(() => {
    if (execution.admittedAt !== null) return;
    const waited = performance.now() - queuedAtMonotonic;
    console.error(
      `[host-run] ${options.label} still waiting after ${formatDuration(waited)} for ${options.lane};`
      + ` ${describeHolders(readHolders(holderRoot), options.lane)}`,
    );
  }, Number.isFinite(waitReportMilliseconds) && waitReportMilliseconds >= 10 ? waitReportMilliseconds : 60_000);
  const remainingWait = (): number => Math.max(
    1_000,
    queueTimeoutMilliseconds - Math.round(performance.now() - queuedAtMonotonic),
  );
  let holderPath: string | null = null;
  try {
    const module = await hostResourceModule(environment);
    const cpuCoordinator = module.createHostResourceCoordinator({
      profile: {
        id: `local-efficiency/v1-${capacity}`,
        capacities: [{ resource: "cpu", limit: capacity }],
      },
      stateRoot,
      waitTimeoutMilliseconds: queueTimeoutMilliseconds,
    });
    const capabilityCoordinator = options.lane === "compute"
      ? null
      : module.createHostResourceCoordinator({
        profile: {
          id: capabilityProfile.id,
          capacities: capabilityProfile.capacities.map((entry) => ({ ...entry })),
        },
        stateRoot: resolveCapabilityStateRoot(stateRoot),
        waitTimeoutMilliseconds: queueTimeoutMilliseconds,
      });
    if (cancellationState.signal !== null) return signalExitCode(cancellationState.signal);
    const runWithCpu = async (outerDescriptors: readonly number[]): Promise<number> => {
      return cpuCoordinator.withLease(
        [{ resource: "cpu", amount: permitCount }],
        async (lease) => {
          execution.admittedAt = new Date();
          execution.runStartedAt = performance.now();
          clearInterval(waitReporter);
          const waitedSeconds = (execution.runStartedAt - queuedAtMonotonic) / 1_000;
          console.error(
            `[host-run] admitted ${options.label} after ${waitedSeconds.toFixed(1)}s`,
          );
          holderPath = registerHolder(holderRoot, {
            admittedAt: execution.admittedAt.toISOString(),
            label: options.label,
            lane: options.lane,
            mode: options.mode,
            permits: permitCount,
            pid: process.pid,
            version: 1,
          }, digest.slice(0, 16));
          const childEnvironment = {
            ...environment,
            ...jobEnvironment(permitCount, capacity, environment),
            ...chromeEnvironment(environment, process.platform, chromeLauncherPath(), options.cwd),
            LOCAL_EFFICIENCY_LEASE: JSON.stringify({
              capacity,
              label: options.label,
              lane: options.lane,
              mode: options.mode,
              permits: permitCount,
              version: 2,
            }),
          };
          try {
            const result = await spawnCommand(
              options.command,
              options.cwd,
              childEnvironment,
              [...outerDescriptors, lease.inheritedFileDescriptor],
              maxHold === null ? null : { label: options.label, maxHoldMilliseconds: maxHold },
            );
            record(
              result.holdTimedOut ? "hold-timeout" : result.exitCode === 0 ? "pass" : "fail",
              result.exitCode,
            );
            return result.exitCode;
          } catch (error: unknown) {
            record("spawn-error", null);
            throw error;
          }
        },
        {
          signal: cancellation.signal,
          waitTimeoutMilliseconds: remainingWait(),
        },
      );
    };
    if (capabilityCoordinator === null) return await runWithCpu([]);
    return await capabilityCoordinator.withLease(
      [{ resource: options.lane, amount: 1 }],
      (lease) => runWithCpu([lease.inheritedFileDescriptor]),
      {
        signal: cancellation.signal,
        waitTimeoutMilliseconds: remainingWait(),
      },
    );
  } catch (error: unknown) {
    if (cancellationState.signal !== null) return signalExitCode(cancellationState.signal);
    record("scheduler-error", null);
    if (execution.admittedAt === null && permissionBoundaryDenied(error)) {
      throw new HostAccessRequiredError();
    }
    if (execution.admittedAt === null && waitTimedOut(error)) {
      throw new QueueTimeoutError(
        options.label,
        options.lane,
        Math.round(performance.now() - queuedAtMonotonic),
      );
    }
    throw error;
  } finally {
    clearInterval(waitReporter);
    releaseHolder(holderPath);
    for (const signal of cancellationSignals) process.off(signal, cancel);
  }
}

function usage(): string {
  return "Usage: host-run --mode=shared|heavy|exclusive"
    + " [--lane=compute|browser|browser-auth|mac-native] [--label=LABEL]"
    + " [--max-hold=DURATION|none] -- COMMAND [ARGUMENT ...]";
}

if (import.meta.main) {
  try {
    const parsed = parseHostRunArguments(process.argv.slice(2));
    process.exitCode = await runHostCommand({ ...parsed, cwd: process.cwd() });
  } catch (error) {
    if (error instanceof HostAccessRequiredError) {
      console.error(`[host-run] ${error.code}: ${error.message}`);
      process.exitCode = hostAccessRequiredExitCode;
    } else if (error instanceof QueueTimeoutError) {
      console.error(`[host-run] QUEUE_TIMEOUT: ${error.message}`);
      process.exitCode = queueTimeoutExitCode;
    } else {
      console.error(`[host-run] ${error instanceof Error ? error.message : String(error)}`);
      console.error(usage());
      process.exitCode = 1;
    }
  }
}
