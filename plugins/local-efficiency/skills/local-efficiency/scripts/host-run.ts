#!/usr/bin/env bun

import { dlopen, FFIType, ptr } from "bun:ffi";
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

import {
  defaultHelperAppPath,
  formatHelperStatus,
  helperConfigPath,
  inspectHelper,
  installHelper,
  parseHelperConfig,
  runPermissionProbe,
} from "./mac-ui-helper";
import { isChromeLauncher, validateChromeExecutable } from "./chrome-launcher";
import {
  MachineLockTimeoutError,
  acquireMachineLock,
  machineLockTimeoutExitCode,
  resolveMachineLockConfig,
  type HeldMachineLock,
} from "./machine-lock";
import {
  type ComputeForwardConfig,
  type ForwardRequest,
  ForwardUnavailableError,
  type PresenceConfig,
  type RemoteForwardConfig,
  RemoteUnreachableError,
  defaultForwardDependencies,
  forwardMacUiRun,
  forwardUnavailableExitCode,
  resolveRemoteConfigs,
  validateArtifactPath,
} from "./mac-ui-forward";
import { forwardComputeRun } from "./compute-forward";
import {
  type HandoffState,
  type Placement,
  type Watcher,
  computeYieldWatcher,
  localLoadPerCore,
  macUiHandoffWatcher,
  placeCompute,
  placeMacUi,
  remoteLoadPerCore,
  samplePresence,
  terminateLeftovers,
  thisHostName,
} from "./placement";
import { type Presence, type PresenceProbe, presenceProbe } from "./presence";

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
export type CapabilityLane = "compute" | "browser" | "browser-auth" | "mac-native" | "mac-ui";

export const capabilityLanes: readonly CapabilityLane[] = [
  "compute",
  "browser",
  "browser-auth",
  "mac-native",
  "mac-ui",
];

export function isCapabilityLane(value: unknown): value is CapabilityLane {
  return value === "compute" || value === "browser" || value === "browser-auth"
    || value === "mac-native" || value === "mac-ui";
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

/**
 * The mac-native lane runs from its own pool so two shared or heavy native
 * jobs (simulator tests, journeys, Swift builds) can overlap; `exclusive`
 * claims both slots. The capabilities-v2 profile keeps its mac-native entry so
 * its digest, and the browser-auth custody it guards, are unchanged; new
 * wrappers simply stop claiming mac-native there.
 */
export const macNativeProfile = Object.freeze({
  id: "local-efficiency/mac-native-v1",
  capacities: Object.freeze([
    Object.freeze({ resource: "mac-native", limit: 2 }),
  ]),
});

/**
 * The mac-ui lane is for native work that drives or shows UI: XCUITest and
 * other UI tests, window-opening journeys, computer use or AppleScript against
 * our own apps, and anything that brings an app window or Simulator.app to the
 * front. One slot, so UI runs never fight over focus. On a workstation with a
 * forwarding config the lane is forwarded to the other Mac (see
 * mac-ui-forward.ts). With a `presence` entry it runs here only while the owner
 * is idle at an unlocked screen (see placeMacUi in placement.ts).
 */
export const macUiProfile = Object.freeze({
  id: "local-efficiency/mac-ui-v1",
  capacities: Object.freeze([
    Object.freeze({ resource: "mac-ui", limit: 1 }),
  ]),
});

/** Slots a mac-native run claims: exclusive takes the whole lane. */
export function macNativeClaimAmount(mode: ResourceMode): number {
  return mode === "exclusive" ? macNativeProfile.capacities[0]!.limit : 1;
}

function capabilityClaimAmount(lane: CapabilityLane, mode: ResourceMode): number {
  return lane === "mac-native" ? macNativeClaimAmount(mode) : 1;
}

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
  if (lane === "mac-ui") candidates.push(60 * minuteMilliseconds);
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
  /** mac-ui only: repo-relative paths copied back from a forwarded run. */
  readonly artifacts?: readonly string[];
  readonly command: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly label: string;
  readonly lane: CapabilityLane;
  /** Wall-clock cap after admission; `null` disables it, `undefined` uses the lane default. */
  readonly maxHoldMilliseconds?: number | null;
  readonly mode: ResourceMode;
  readonly stateRoot?: string;
  readonly fullCpu?: boolean;
  /** compute and mac-ui: run on this Mac whatever the placement says. */
  readonly local?: boolean;
  /** compute and mac-ui: run on the configured remote Mac or fail; never here. */
  readonly remote?: boolean;
};

function validateFullCpu(mode: ResourceMode, lane: CapabilityLane, fullCpu: unknown): void {
  if (fullCpu !== undefined && typeof fullCpu !== "boolean") {
    throw new Error("--full-cpu must be a boolean");
  }
  if (fullCpu === true && (mode !== "exclusive" || lane !== "mac-native")) {
    throw new Error("--full-cpu requires --mode=exclusive --lane=mac-native");
  }
}

/**
 * Weighted CPU permits for this host. Hosts with 16+ cores get 6 permits; job
 * thread hints (HRA_JOBS etc.) scale down per permit, so the total thread
 * budget stays at the core count while more jobs overlap.
 */
export function permitCapacity(hostParallelism = availableParallelism()): number {
  if (hostParallelism >= 16) return 6;
  return legacyPermitCapacity(hostParallelism);
}

/** The pre-0.5.4 capacity, still honoured for leases inherited from an older outer wrapper. */
export function legacyPermitCapacity(hostParallelism = availableParallelism()): number {
  if (hostParallelism >= 12) return 4;
  if (hostParallelism >= 6) return 3;
  if (hostParallelism >= 3) return 2;
  return 1;
}

export function permitsForMode(
  mode: ResourceMode,
  hostParallelism = availableParallelism(),
  lane: CapabilityLane = "compute",
  fullCpu = false,
): number {
  return expectedPermits(mode, permitCapacity(hostParallelism), lane, fullCpu);
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

function validatePlacementFlags(lane: CapabilityLane, local: unknown, remote: unknown): void {
  if (local === true && remote === true) throw new Error("--local and --remote cannot be combined");
  if ((local === true || remote === true) && lane !== "compute" && lane !== "mac-ui") {
    throw new Error("--local and --remote are only valid with --lane=compute or --lane=mac-ui; other lanes always run here");
  }
}

export function parseHostRunArguments(arguments_: readonly string[]): {
  readonly artifacts?: readonly string[];
  readonly command: readonly string[];
  readonly label: string;
  readonly lane: CapabilityLane;
  readonly maxHoldMilliseconds?: number | null;
  readonly mode: ResourceMode;
  readonly fullCpu?: boolean;
  readonly local?: boolean;
  readonly remote?: boolean;
} {
  const delimiter = arguments_.indexOf("--");
  if (delimiter < 0) throw new Error("host-run requires -- before its command");
  let label: string | undefined;
  let lane: CapabilityLane = "compute";
  let laneSupplied = false;
  let mode: ResourceMode | undefined;
  let maxHold: number | null | undefined;
  let maxHoldSupplied = false;
  let fullCpu = false;
  let local = false;
  let remote = false;
  const artifacts: string[] = [];
  for (const argument of arguments_.slice(0, delimiter)) {
    if (argument.startsWith("--artifacts=")) {
      artifacts.push(validateArtifactPath(argument.slice("--artifacts=".length)));
      continue;
    }
    if (argument === "--local") {
      if (local) throw new Error("--local may appear only once");
      local = true;
      continue;
    }
    if (argument === "--remote") {
      if (remote) throw new Error("--remote may appear only once");
      remote = true;
      continue;
    }
    if (argument === "--full-cpu") {
      if (fullCpu) throw new Error("--full-cpu may appear only once");
      fullCpu = true;
      continue;
    }
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
  validateFullCpu(mode ?? "shared", lane, fullCpu);
  if (artifacts.length > 0 && lane !== "mac-ui") {
    throw new Error("--artifacts is only valid with --lane=mac-ui");
  }
  validatePlacementFlags(lane, local, remote);
  return {
    ...(artifacts.length > 0 ? { artifacts: [...new Set(artifacts)] } : {}),
    command,
    ...(fullCpu ? { fullCpu: true } : {}),
    label: label ?? commandProgramLabel(command[0]),
    lane,
    ...(local ? { local: true } : {}),
    ...(remote ? { remote: true } : {}),
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

export function resolveMacNativeStateRoot(hostResourceStateRoot: string): string {
  return join(resolve(hostResourceStateRoot, ".."), "mac-native-v1");
}

export function resolveMacUiStateRoot(hostResourceStateRoot: string): string {
  return join(resolve(hostResourceStateRoot, ".."), "mac-ui-v1");
}

/**
 * The Atet coordinator pins one profile per state directory, so a CPU pool of
 * a new size gets its own directory; capacities up to 4 keep the original one.
 */
export function resolveCpuStateRoot(hostResourceStateRoot: string, capacity: number): string {
  return capacity <= 4
    ? hostResourceStateRoot
    : join(resolve(hostResourceStateRoot, ".."), `host-resources-cpu${capacity}`);
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
  watch: Watcher | null = null,
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
    const watchTimers: ReturnType<typeof setTimeout>[] = [];
    const stopWatching = watch === null || child.pid === undefined
      ? () => {}
      : watch({
        pid: child.pid,
        stop: (graceMs) => {
          signalChildTree("SIGTERM");
          watchTimers.push(setTimeout(() => signalChildTree("SIGKILL"), graceMs));
        },
      });
    const removeSignalHandlers = (): void => {
      for (const signal of forwardedSignals) process.off(signal, forward);
      for (const timer of holdTimers) clearTimeout(timer);
      for (const timer of watchTimers) clearTimeout(timer);
      stopWatching();
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
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 6
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
  fullCpu = false,
): number {
  validateFullCpu(mode, lane, fullCpu);
  if (fullCpu) return capacity;
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

type MarkerCoverage = {
  readonly profileDigests: readonly string[];
  readonly claims: readonly { readonly amount: number; readonly resource: string }[];
};

function assertMarker(
  descriptor: number,
  profileDigests: readonly string[],
  claims: readonly { readonly amount: number; readonly resource: string }[],
): void {
  assertMarkerCoverage(descriptor, [{ profileDigests, claims }]);
}

function assertMarkerCoverage(descriptor: number, accepted: readonly MarkerCoverage[]): void {
  const marker = inheritedMarker(descriptor);
  const covered = accepted.some((entry) =>
    entry.profileDigests.includes(marker.profileSha256)
    && JSON.stringify(marker.claims) === JSON.stringify(entry.claims));
  if (!covered) throw new Error("inherited local-efficiency lease descriptor does not cover this request");
}

function assertInheritedLeaseDescriptors(inherited: InheritedLease): void {
  if (inherited.capacity !== permitCapacity() && inherited.capacity !== legacyPermitCapacity()) {
    throw new Error("inherited local-efficiency lease capacity changed");
  }
  let descriptor = 3;
  if (inherited.lane === "mac-native") {
    assertMarkerCoverage(descriptor, [
      {
        profileDigests: [expectedProfileDigest(macNativeProfile)],
        claims: [{ resource: "mac-native", amount: macNativeClaimAmount(inherited.mode) }],
      },
      {
        // An outer wrapper from before mac-native-v1 claimed one slot in the shared profile.
        profileDigests: [expectedProfileDigest(capabilityProfile), expectedProfileDigest(legacyCapabilityProfile)],
        claims: [{ resource: "mac-native", amount: 1 }],
      },
    ]);
    descriptor += 1;
  } else if (inherited.lane === "mac-ui") {
    assertMarker(descriptor, [expectedProfileDigest(macUiProfile)], [{ resource: "mac-ui", amount: 1 }]);
    descriptor += 1;
  } else if (inherited.lane !== "compute") {
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
  requested: Pick<HostRunOptions, "lane" | "mode" | "fullCpu">,
): boolean {
  // The signed-in browser owner may also drive headless browsers, and the
  // mac-ui owner may run the native builds its UI tests need.
  const capabilityCovered = requested.lane === "compute"
    || inherited.lane === requested.lane
    || (requested.lane === "browser" && inherited.lane === "browser-auth")
    || (requested.lane === "mac-native" && inherited.lane === "mac-ui");
  return capabilityCovered
    && modeRank(inherited.mode) >= modeRank(requested.mode)
    && expectedPermits(requested.mode, inherited.capacity, requested.lane, requested.fullCpu) <= inherited.permits;
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
  return (lane !== "mac-native" && lane !== "mac-ui") || platform === "darwin";
}

export type ProcessStartIdentity = {
  readonly startedAtMs?: number;
  readonly token: string;
};

export type HolderRecord = {
  readonly admittedAt: string;
  readonly label: string;
  readonly lane: CapabilityLane;
  readonly mode: ResourceMode;
  readonly permits: number;
  readonly pid: number;
  readonly pidStartToken?: string;
  readonly version: 1;
};

const holderFilePattern = /^([1-9][0-9]*)-[0-9a-f]{8,64}\.json$/u;
const legacySkewToleranceMilliseconds = 60_000;
const darwinProcPidTbsdInfo = 3;
const darwinProcBsdInfoSize = 136;

let darwinProcPidInfoSymbol: ((
  pid: number,
  flavor: number,
  arg: bigint,
  buffer: ReturnType<typeof ptr>,
  bufferSize: number,
) => number) | null | undefined;
let cachedLinuxBootId: string | undefined;

function darwinProcPidInfo() {
  if (darwinProcPidInfoSymbol !== undefined) return darwinProcPidInfoSymbol;
  try {
    const library = dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    darwinProcPidInfoSymbol = (pid, flavor, arg, buffer, bufferSize) =>
      library.symbols.proc_pidinfo(pid, flavor, arg, buffer, bufferSize);
  } catch {
    darwinProcPidInfoSymbol = null;
  }
  return darwinProcPidInfoSymbol;
}

function linuxBootId(): string {
  if (cachedLinuxBootId !== undefined) return cachedLinuxBootId;
  try {
    cachedLinuxBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || "boot";
  } catch {
    cachedLinuxBootId = "boot";
  }
  return cachedLinuxBootId;
}

export function processStartIdentity(pid: number): ProcessStartIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "darwin") {
    const fn = darwinProcPidInfo();
    if (fn === null) return null;
    try {
      const buffer = Buffer.alloc(darwinProcBsdInfoSize);
      const written = fn(pid, darwinProcPidTbsdInfo, 0n, ptr(buffer), darwinProcBsdInfoSize);
      if (written < darwinProcBsdInfoSize) return null;
      const seconds = buffer.readBigUInt64LE(120);
      const microseconds = buffer.readBigUInt64LE(128);
      if (seconds <= 0n) return null;
      return {
        startedAtMs: Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000),
        token: `darwin:${seconds}:${microseconds}`,
      };
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = raw.lastIndexOf(") ");
      if (closeParen < 0) return null;
      const fields = raw.slice(closeParen + 2).trim().split(/\s+/u);
      const startTicks = fields[19];
      if (startTicks === undefined || !/^[0-9]+$/u.test(startTicks)) return null;
      return { token: `linux:${linuxBootId()}:${startTicks}` };
    } catch {
      return null;
    }
  }
  return null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function isValidHolderRecordShape(parsed: unknown): parsed is HolderRecord {
  if (typeof parsed !== "object" || parsed === null) return false;
  const candidate = parsed as Partial<HolderRecord>;
  return candidate.version === 1
    && typeof candidate.pid === "number"
    && Number.isSafeInteger(candidate.pid)
    && typeof candidate.label === "string"
    && typeof candidate.admittedAt === "string"
    && isCapabilityLane(candidate.lane)
    && (candidate.pidStartToken === undefined || typeof candidate.pidStartToken === "string");
}

function holderProcessMatches(
  record: HolderRecord,
  alive: (pid: number) => boolean,
  startIdentity: (pid: number) => ProcessStartIdentity | null,
): boolean {
  if (!alive(record.pid)) return false;
  const current = startIdentity(record.pid);
  if (current === null) return true;
  if (record.pidStartToken !== undefined && record.pidStartToken !== "") {
    return current.token === record.pidStartToken;
  }
  if (current.startedAtMs !== undefined) {
    const admittedMs = Date.parse(record.admittedAt);
    if (
      Number.isFinite(admittedMs)
      && current.startedAtMs > admittedMs + legacySkewToleranceMilliseconds
    ) {
      return false;
    }
  }
  return true;
}

function holderFileName(pid: number, token: string): string {
  return `${pid}-${token}.json`;
}

/** Records who holds a lease so waiters can say what blocks them. Best effort. */
export function registerHolder(root: string, record: HolderRecord, token: string): string | null {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const identity = record.pidStartToken === undefined && record.pid === process.pid
      ? processStartIdentity(record.pid)
      : null;
    const stored: HolderRecord = identity === null
      ? record
      : { ...record, pidStartToken: identity.token };
    const path = join(root, holderFileName(record.pid, token));
    writeFileSync(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
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

/**
 * Removes holder records left behind by crashed/SIGKILLed processes whose PID is
 * dead or has been recycled by the kernel. Invoked only on write paths.
 */
export function pruneStaleHolders(
  root: string,
  alive: (pid: number) => boolean = processAlive,
  startIdentity: (pid: number) => ProcessStartIdentity | null =
    alive === processAlive ? processStartIdentity : () => null,
): number {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = holderFilePattern.exec(name);
    if (match === null) continue;
    const filePid = Number(match[1]);
    const path = join(root, name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isValidHolderRecordShape(parsed) && !holderProcessMatches(parsed, alive, startIdentity)) {
        unlinkSync(path);
        removed += 1;
      }
    } catch {
      if (!alive(filePid)) {
        try {
          unlinkSync(path);
          removed += 1;
        } catch {
          // racing release
        }
      }
    }
  }
  return removed;
}

/** Live holders only; records whose process is gone or recycled are ignored, never trusted. */
export function readHolders(
  root: string,
  alive: (pid: number) => boolean = processAlive,
  startIdentity: (pid: number) => ProcessStartIdentity | null =
    alive === processAlive ? processStartIdentity : () => null,
): HolderRecord[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const holders: HolderRecord[] = [];
  for (const name of names.filter((entry) => holderFilePattern.test(entry)).slice(0, 1_024)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(root, name), "utf8"));
      if (isValidHolderRecordShape(parsed) && holderProcessMatches(parsed, alive, startIdentity)) {
        holders.push(parsed);
      }
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
  validateFullCpu(options.mode, options.lane, options.fullCpu);
  const environment = { ...(options.environment ?? process.env) };
  if (options.artifacts !== undefined && options.artifacts.length > 0 && options.lane !== "mac-ui") {
    throw new Error("--artifacts is only valid with --lane=mac-ui");
  }
  validatePlacementFlags(options.lane, options.local, options.remote);
  const forwarded = environment.LOCAL_EFFICIENCY_FORWARDED === "1";
  const nested = environment.LOCAL_EFFICIENCY_LEASE !== undefined;
  let watch: Watcher | null = null;
  if (
    options.lane === "compute"
    && !forwarded
    && !nested
    && (options.mode === "heavy" || options.mode === "exclusive")
  ) {
    const placed = await placeHeavyCompute(options, environment);
    if (placed.kind === "ran") return placed.exitCode;
    watch = placed.watch;
  } else if (options.lane === "compute" && options.remote === true) {
    throw new Error("--remote needs --mode=heavy or --mode=exclusive at the top level; this run is shared or nested");
  }
  if (options.lane === "mac-ui") {
    const remote = resolveRemoteConfigs(environment);
    const forward = remote.macUi;
    const request = forwardRequest(options);
    if (options.remote === true) {
      if (forward === null) throw new Error("--remote needs a macUi entry in host-run/remote.json");
      console.error(`[host-run] placing ${options.label} on ${forward.forwardTo}: --remote`);
      return await forwardMacUiRun(request, forward, defaultForwardDependencies(environment));
    }
    if (forward !== null && options.local === true) {
      console.error(`[host-run] placing ${options.label} on ${thisHostName()}: --local`);
    } else if (forward !== null) {
      const probe = remote.presence === null ? null : presenceProbe(environment);
      if (remote.presence !== null && probe === null) {
        console.error("[host-run] presence is unavailable on this platform; forwarding as configured");
      }
      if (remote.presence === null || probe === null) {
        // A workstation without presence placement never runs UI-driving work itself.
        return await forwardMacUiRun(request, forward, defaultForwardDependencies(environment));
      }
      return await placeMacUiRun(options, environment, request, forward, remote.presence, probe);
    }
  }
  return await runHere(options, environment, forwarded, watch);
}

function forwardRequest(options: HostRunOptions): ForwardRequest {
  return {
    artifacts: options.artifacts ?? [],
    command: options.command,
    cwd: options.cwd,
    label: options.label,
    ...(options.maxHoldMilliseconds === undefined ? {} : { maxHoldMilliseconds: options.maxHoldMilliseconds }),
    mode: options.mode,
  };
}

function testMilliseconds(environment: Readonly<NodeJS.ProcessEnv>, name: string, fallback: number): number {
  const value = Number(environment[name]);
  return Number.isFinite(value) && value >= 10 ? value : fallback;
}

async function safeSample(probe: PresenceProbe, config: PresenceConfig): Promise<Presence | null> {
  try {
    return await samplePresence(probe, config);
  } catch (error: unknown) {
    console.error(`[host-run] presence check failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

type ComputePlacement =
  | { readonly kind: "ran"; readonly exitCode: number }
  | { readonly kind: "here"; readonly watch: Watcher | null };

/**
 * Heavy compute on a workstation: forward it while the owner is busy or the
 * other Mac has more room, keep it here while they are idle or away. A run
 * kept here drops to background priority whenever the owner comes back.
 */
async function placeHeavyCompute(options: HostRunOptions, environment: NodeJS.ProcessEnv): Promise<ComputePlacement> {
  const remote = resolveRemoteConfigs(environment);
  const compute: ComputeForwardConfig | null = remote.compute !== null
    && (options.mode === "heavy" || options.mode === "exclusive")
    && remote.compute.modes.includes(options.mode)
    ? remote.compute
    : null;
  const deps = defaultForwardDependencies(environment);
  const forward = async (): Promise<ComputePlacement | null> => {
    if (compute === null) return null;
    const outcome = await forwardComputeRun({ ...forwardRequest(options), mode: options.mode as "heavy" | "exclusive" }, compute, deps);
    if (outcome.ran) return { exitCode: outcome.exitCode, kind: "ran" };
    if (options.remote === true) throw new ForwardUnavailableError(`${options.label} was not forwarded: ${outcome.reason}`);
    console.error(`[host-run] running ${options.label} on this Mac: ${outcome.reason}`);
    return null;
  };
  if (options.remote === true) {
    if (compute === null) {
      throw new Error(`--remote needs a compute entry in host-run/remote.json that covers --mode=${options.mode}`);
    }
    console.error(`[host-run] placing ${options.label} on ${compute.forwardTo}: --remote`);
    return (await forward())!;
  }
  const probe = remote.presence === null ? null : presenceProbe(environment);
  if (remote.presence !== null && probe === null) {
    console.error("[host-run] presence is unavailable on this platform; placing as configured");
  }
  const config = remote.presence;
  const yieldWatch = (initial: Presence | null): Watcher | null =>
    probe === null || config === null
      ? null
      : computeYieldWatcher(
        probe,
        config,
        options.label,
        (line) => console.error(line),
        initial?.busy === true ? initial : null,
        testMilliseconds(environment, "LOCAL_EFFICIENCY_PRESENCE_POLL_MS", Math.max(config.pollSeconds, 5) * 1_000),
      );
  if (options.local === true) {
    if (compute !== null || config !== null) console.error(`[host-run] placing ${options.label} on ${thisHostName()}: --local`);
    return { kind: "here", watch: yieldWatch(probe === null || config === null ? null : await safeSample(probe, config)) };
  }
  if (compute === null) {
    return { kind: "here", watch: yieldWatch(probe === null || config === null ? null : await safeSample(probe, config)) };
  }
  if (probe === null || config === null) {
    // 0.8 behaviour: always try the remote first.
    return (await forward()) ?? { kind: "here", watch: null };
  }
  const presence = await safeSample(probe, config);
  if (presence === null) return (await forward()) ?? { kind: "here", watch: null };
  let placement: Placement;
  if (presence.busy) {
    placement = { here: false, reason: presence.reason };
  } else {
    const overrides = presence.facts.load;
    let localFreePermits = overrides?.localFreePermits;
    if (localFreePermits === undefined) {
      try {
        localFreePermits = hostStatusReport({
          environment,
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        }).availablePermits;
      } catch {
        localFreePermits = permitCapacity();
      }
    }
    placement = placeCompute(presence, {
      localFreePermits,
      localLoadPerCore: overrides?.local ?? localLoadPerCore(),
      needed: permitsForMode(options.mode),
      remoteLoadPerCore: overrides !== undefined && "remote" in overrides
        ? overrides.remote ?? null
        : remoteLoadPerCore(deps, compute),
      remoteName: compute.forwardTo,
    });
  }
  if (placement.here) {
    console.error(`[host-run] placing ${options.label} on ${thisHostName()}: ${placement.reason}`);
    return { kind: "here", watch: yieldWatch(presence) };
  }
  console.error(`[host-run] placing ${options.label} on ${compute.forwardTo}: ${placement.reason}`);
  return (await forward()) ?? { kind: "here", watch: yieldWatch(presence) };
}

/**
 * UI work on a workstation: run it here only while the owner is idle at an
 * unlocked screen, stop and rerun it on the other Mac if they come back,
 * and otherwise forward it. When the other Mac is unreachable, wait (up to
 * `waitMinutes`) for either the owner to go idle or the other Mac to answer.
 */
async function placeMacUiRun(
  options: HostRunOptions,
  environment: NodeJS.ProcessEnv,
  request: ForwardRequest,
  forward: RemoteForwardConfig,
  config: PresenceConfig,
  probe: PresenceProbe,
): Promise<number> {
  const deps = defaultForwardDependencies(environment);
  const pollMs = testMilliseconds(environment, "LOCAL_EFFICIENCY_PRESENCE_POLL_MS", config.pollSeconds * 1_000);
  const waitMs = testMilliseconds(environment, "LOCAL_EFFICIENCY_PRESENCE_WAIT_MS", config.waitMinutes * 60_000);
  const retryMs = testMilliseconds(environment, "LOCAL_EFFICIENCY_PRESENCE_RETRY_MS", 60_000);
  const effective = { ...config, pollSeconds: pollMs / 1_000 };
  const startedWaiting = performance.now();
  let lastRemoteAttempt = Number.NEGATIVE_INFINITY;
  let unreachableReported = false;
  let lastReason = "";
  for (;;) {
    const presence = await safeSample(probe, config);
    const placement: Placement = presence === null
      ? { here: false, reason: "presence check failed" }
      : placeMacUi(presence);
    lastReason = placement.reason;
    if (placement.here) {
      console.error(`[host-run] placing ${options.label} on ${thisHostName()}: ${placement.reason}`);
      const state: HandoffState = { seen: new Map(), stoppedFor: null };
      const exitCode = await runHere(
        options,
        environment,
        false,
        macUiHandoffWatcher(probe, effective, state, (line) => console.error(line)),
      );
      if (state.stoppedFor === null) return exitCode;
      const left = terminateLeftovers(state.seen);
      console.error(
        `[host-run] ${options.label} stopped on ${thisHostName()} (${state.stoppedFor.reason})`
        + `${left > 0 ? `; sent TERM to ${left} leftover process${left === 1 ? "" : "es"}` : ""}`
        + `; rerunning it on ${forward.forwardTo}`,
      );
      lastRemoteAttempt = Number.NEGATIVE_INFINITY;
      continue;
    }
    if (performance.now() - lastRemoteAttempt >= retryMs) {
      lastRemoteAttempt = performance.now();
      if (!unreachableReported) console.error(`[host-run] placing ${options.label} on ${forward.forwardTo}: ${placement.reason}`);
      try {
        return await forwardMacUiRun(request, forward, deps);
      } catch (error: unknown) {
        if (!(error instanceof RemoteUnreachableError)) throw error;
        if (!unreachableReported) {
          console.error(
            `[host-run] ${error.message}; waiting up to ${formatDuration(waitMs)} for the owner to go idle`
            + ` or ${forward.forwardTo} to answer (never stealing focus here meanwhile)`,
          );
          unreachableReported = true;
        }
      }
    }
    if (performance.now() - startedWaiting >= waitMs) {
      throw new ForwardUnavailableError(
        `${options.label} did not run: the owner stayed busy here (${lastReason})`
        + ` and ${forward.forwardTo} stayed unreachable for ${formatDuration(waitMs)}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
  }
}

async function runHere(
  options: HostRunOptions,
  environment: NodeJS.ProcessEnv,
  forwarded: boolean,
  watch: Watcher | null,
): Promise<number> {
  if (!capabilityPlatformSupported(options.lane)) {
    throw new Error(`the ${options.lane} capability lane requires macOS`);
  }
  const inheritedValue = environment.LOCAL_EFFICIENCY_LEASE;
  if (inheritedValue !== undefined) {
    const inherited = parseInheritedLease(inheritedValue);
    if (!inheritedLeaseCovers(inherited, options)) {
      throw new Error("nested host-run cannot escalate its outer mode or capability lane");
    }
    assertInheritedLeaseDescriptors(inherited);
    return (await spawnCommand(options.command, options.cwd, environment, [], null, watch)).exitCode;
  }
  // A machine that also runs timed CI measurements may name a CI machine
  // lock. mac-ui runs, and compute runs forwarded here from a workstation,
  // hold it shared for the whole command, taken before the lane lease so no
  // slot is held while CI measures.
  let machineLock: HeldMachineLock | null = null;
  if (options.lane === "mac-ui" || (options.lane === "compute" && forwarded)) {
    const lockConfig = resolveMachineLockConfig(environment);
    if (lockConfig !== null) {
      const interrupted: { signal: NodeJS.Signals | null } = { signal: null };
      const onSignal = (signal: NodeJS.Signals): void => { interrupted.signal ??= signal; };
      const lockSignals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
      for (const signal of lockSignals) process.on(signal, onSignal);
      try {
        machineLock = await acquireMachineLock(lockConfig, { cancelled: () => interrupted.signal !== null });
      } finally {
        for (const signal of lockSignals) process.off(signal, onSignal);
      }
      if (machineLock === null) {
        console.error(`[host-run] ${interrupted.signal}: stopped waiting for the CI machine lock`);
        return signalExitCode(interrupted.signal ?? "SIGTERM");
      }
    }
  }
  try {
    return await runLeasedCommand(options, environment, watch);
  } finally {
    machineLock?.release();
  }
}

async function runLeasedCommand(
  options: HostRunOptions,
  environment: NodeJS.ProcessEnv,
  watch: Watcher | null,
): Promise<number> {
  const capacity = permitCapacity();
  const permitCount = permitsForMode(options.mode, availableParallelism(), options.lane, options.fullCpu);
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
      stateRoot: resolveCpuStateRoot(stateRoot, capacity),
      waitTimeoutMilliseconds: queueTimeoutMilliseconds,
    });
    const laneProfile = options.lane === "mac-native"
      ? macNativeProfile
      : options.lane === "mac-ui"
        ? macUiProfile
        : capabilityProfile;
    const capabilityCoordinator = options.lane === "compute"
      ? null
      : module.createHostResourceCoordinator({
        profile: {
          id: laneProfile.id,
          capacities: laneProfile.capacities.map((entry) => ({ ...entry })),
        },
        stateRoot: options.lane === "mac-native"
          ? resolveMacNativeStateRoot(stateRoot)
          : options.lane === "mac-ui"
            ? resolveMacUiStateRoot(stateRoot)
            : resolveCapabilityStateRoot(stateRoot),
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
          pruneStaleHolders(holderRoot);
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
              watch,
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
      [{ resource: options.lane, amount: capabilityClaimAmount(options.lane, options.mode) }],
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

export type HostRunCliAction =
  | { readonly kind: "help" }
  | { readonly json: boolean; readonly kind: "status" }
  | { readonly kind: "presence" }
  | { readonly appPath: string | null; readonly kind: "mac-ui"; readonly subcommand: MacUiSubcommand }
  | { readonly kind: "run"; readonly parsed: ReturnType<typeof parseHostRunArguments> };

export type MacUiSubcommand = "install-helper" | "helper-status" | "probe";

export function parseHostRunCli(arguments_: readonly string[]): HostRunCliAction {
  if (arguments_[0] === "presence") {
    if (arguments_.length > 1) throw new Error("usage: host-run presence");
    return { kind: "presence" };
  }
  if (arguments_[0] === "mac-ui") {
    const subcommand = arguments_[1];
    if (subcommand !== "install-helper" && subcommand !== "helper-status" && subcommand !== "probe") {
      throw new Error("usage: host-run mac-ui install-helper [--app=PATH] | helper-status | probe");
    }
    let appPath: string | null = null;
    for (const argument of arguments_.slice(2)) {
      if (subcommand === "install-helper" && argument.startsWith("--app=") && appPath === null) {
        appPath = argument.slice("--app=".length);
        if (!appPath.startsWith("/") || !appPath.endsWith(".app")) throw new Error("--app must be an absolute path ending in .app");
      } else {
        throw new Error(`unknown host-run mac-ui ${subcommand} argument: ${argument}`);
      }
    }
    return { appPath, kind: "mac-ui", subcommand };
  }
  if (!arguments_.includes("--")) {
    if (arguments_.length === 1 && (arguments_[0] === "-h" || arguments_[0] === "--help")) {
      return { kind: "help" };
    }
    if (arguments_.includes("--status")) {
      let json = false;
      let statusCount = 0;
      for (const argument of arguments_) {
        if (argument === "--status") statusCount += 1;
        else if (argument === "--json") {
          if (json) throw new Error("--json may appear only once");
          json = true;
        } else {
          throw new Error(`unknown host-run --status argument: ${argument}`);
        }
      }
      if (statusCount > 1) throw new Error("--status may appear only once");
      return { json, kind: "status" };
    }
  }
  return { kind: "run", parsed: parseHostRunArguments(arguments_) };
}

export type HostStatusLaneSummary = {
  readonly activeCount: number;
  readonly limit: number | null;
  readonly resource: CapabilityLane;
};

export type HostStatusHolder = HolderRecord & {
  readonly heldMilliseconds: number;
  readonly heldText: string;
};

export type HostStatusReport = {
  readonly availablePermits: number;
  readonly capacity: number;
  readonly generatedAt: string;
  readonly holders: readonly HostStatusHolder[];
  readonly hostParallelism: number;
  readonly lanes: readonly HostStatusLaneSummary[];
  readonly note: "partial-holder-census-not-admission-authority";
  readonly profileId: string;
  readonly usedPermits: number;
  readonly version: 1;
};

function probeReadableStateDirectory(path: string): void {
  try {
    readdirSync(path);
  } catch (error: unknown) {
    if (permissionBoundaryDenied(error)) throw new HostAccessRequiredError();
  }
}

export function hostStatusReport(options: {
  readonly alive?: (pid: number) => boolean;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly hostParallelism?: number;
  readonly now?: Date;
  readonly startIdentity?: (pid: number) => ProcessStartIdentity | null;
  readonly stateRoot?: string;
} = {}): HostStatusReport {
  const environment = options.environment ?? process.env;
  const now = options.now ?? new Date();
  const hostParallelism = options.hostParallelism ?? availableParallelism();
  const capacity = permitCapacity(hostParallelism);
  const stateRoot = options.stateRoot ?? resolveHostResourceStateRoot(environment);
  const holderRoot = resolveHolderRoot(stateRoot);
  probeReadableStateDirectory(stateRoot);
  probeReadableStateDirectory(holderRoot);
  const rawHolders = readHolders(holderRoot, options.alive, options.startIdentity);
  const holders: HostStatusHolder[] = rawHolders.map((holder) => {
    const admittedMs = Date.parse(holder.admittedAt);
    const heldMilliseconds = Number.isFinite(admittedMs)
      ? Math.max(0, now.getTime() - admittedMs)
      : 0;
    return {
      ...holder,
      heldMilliseconds,
      heldText: formatDuration(heldMilliseconds),
    };
  });
  const usedPermits = Math.min(
    capacity,
    holders.reduce((sum, holder) => sum + holder.permits, 0),
  );
  const laneLimits = new Map<CapabilityLane, number | null>([
    ["compute", null],
    ...capabilityProfile.capacities.map((entry) => [entry.resource as CapabilityLane, entry.limit] as const),
    ...macNativeProfile.capacities.map((entry) => [entry.resource as CapabilityLane, entry.limit] as const),
    ...macUiProfile.capacities.map((entry) => [entry.resource as CapabilityLane, entry.limit] as const),
  ]);
  const lanes: HostStatusLaneSummary[] = capabilityLanes.map((resource) => ({
    activeCount: holders.filter((holder) => holder.lane === resource).length,
    limit: laneLimits.get(resource) ?? null,
    resource,
  }));
  return {
    availablePermits: Math.max(0, capacity - usedPermits),
    capacity,
    generatedAt: now.toISOString(),
    holders,
    hostParallelism,
    lanes,
    note: "partial-holder-census-not-admission-authority",
    profileId: capabilityProfile.id,
    usedPermits,
    version: 1,
  };
}

export function formatHostStatus(report: HostStatusReport): string {
  const lines = [
    `CAPACITY\tcpu=${report.usedPermits}/${report.capacity}\tavailable=${report.availablePermits}\tcores=${report.hostParallelism}\tprofile=${report.profileId}`,
    ...report.lanes.map((lane) =>
      `LANE\t${lane.resource}\tactive=${lane.activeCount}\tlimit=${lane.limit === null ? "cpu-permits" : String(lane.limit)}`),
  ];
  if (report.holders.length === 0) {
    lines.push("HOLDERS\tnone");
  } else {
    for (const holder of report.holders) {
      lines.push(
        `HOLDER\tpid=${holder.pid}\tlane=${holder.lane}\tmode=${holder.mode}\tpermits=${holder.permits}\theld=${holder.heldText}\tlabel=${holder.label}`,
      );
    }
  }
  lines.push("NOTE\tHolder reports are a live-process census, not admission authority.");
  return lines.join("\n");
}

function runMacUiSubcommand(subcommand: MacUiSubcommand, appPath: string | null): number {
  if (subcommand === "probe") {
    const probe = runPermissionProbe();
    console.log(probe.text);
    return probe.lines.every((line) => line.granted) ? 0 : 1;
  }
  const configPath = helperConfigPath();
  const configured = existsSync(configPath);
  if (subcommand === "install-helper") {
    installHelper({ appPath: appPath ?? defaultHelperAppPath(), configPath });
    return 0;
  }
  const app = configured ? parseHelperConfig(readFileSync(configPath, "utf8"), configPath).app : defaultHelperAppPath();
  const status = inspectHelper(app);
  console.log(formatHelperStatus(status, configPath, configured));
  return configured && !status.upToDate ? 1 : 0;
}

/** `host-run presence`: this Mac's presence as JSON, and where UI work and heavy compute would go. */
async function printPresence(): Promise<number> {
  const configs = resolveRemoteConfigs(process.env);
  const config: PresenceConfig = configs.presence
    ?? { graceSeconds: 15, keyIdleMinutes: 5, pollSeconds: 2, waitMinutes: 60 };
  const probe = presenceProbe(process.env);
  if (probe === null) {
    console.log(JSON.stringify({ available: false, reason: "presence needs macOS" }, null, 2));
    return 1;
  }
  const presence = await samplePresence(probe, config);
  const macUi = placeMacUi(presence);
  console.log(JSON.stringify({
    available: true,
    busy: presence.busy,
    configured: configs.presence !== null,
    facts: presence.facts,
    host: thisHostName(),
    keyIdleMinutes: config.keyIdleMinutes,
    macUi: { here: macUi.here, reason: macUi.reason },
    reason: presence.reason,
    state: presence.state,
  }, null, 2));
  return 0;
}

function usage(): string {
  return [
    "Usage: host-run --mode=shared|heavy|exclusive"
      + " [--lane=compute|browser|browser-auth|mac-native|mac-ui] [--label=LABEL]"
      + " [--full-cpu] [--local|--remote] [--max-hold=DURATION|none] [--artifacts=PATH ...] -- COMMAND [ARGUMENT ...]",
    "       host-run --status [--json]",
    "       host-run presence",
    "       host-run mac-ui install-helper [--app=PATH] | helper-status | probe",
    "       host-run --help",
  ].join("\n");
}

if (import.meta.main) {
  try {
    const action = parseHostRunCli(process.argv.slice(2));
    if (action.kind === "help") {
      console.log(usage());
      process.exitCode = 0;
    } else if (action.kind === "status") {
      const report = hostStatusReport();
      console.log(action.json ? JSON.stringify(report, null, 2) : formatHostStatus(report));
      process.exitCode = 0;
    } else if (action.kind === "mac-ui") {
      process.exitCode = runMacUiSubcommand(action.subcommand, action.appPath);
    } else if (action.kind === "presence") {
      process.exitCode = await printPresence();
    } else {
      process.exitCode = await runHostCommand({ ...action.parsed, cwd: process.cwd() });
    }
  } catch (error) {
    if (error instanceof HostAccessRequiredError) {
      console.error(`[host-run] ${error.code}: ${error.message}`);
      process.exitCode = hostAccessRequiredExitCode;
    } else if (error instanceof ForwardUnavailableError) {
      console.error(`[host-run] ${error.code}: ${error.message}`);
      process.exitCode = forwardUnavailableExitCode;
    } else if (error instanceof MachineLockTimeoutError) {
      console.error(`[host-run] ${error.code}: ${error.message}`);
      process.exitCode = machineLockTimeoutExitCode;
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
