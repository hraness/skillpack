/**
 * Is the owner of this Mac using it in a way a run would disturb?
 *
 * Every signal is read without a privacy prompt or grant: per-type input idle
 * times from the HID system (no Input Monitoring needed), the session's lock
 * state, display sleep, CoreAudio and CoreMediaIO "running somewhere" flags,
 * and power assertions. A fixture file can stand in for all of it in tests.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { dlopen, FFIType, ptr } from "bun:ffi";

import type { DeviceState } from "./presence-devices";

export type VideoAssertion = {
  readonly name: string;
  readonly pid: number;
  readonly process: string;
};

export type PresenceFacts = {
  /** Seconds since the last key press (modifier keys included). */
  readonly keyIdleSeconds: number;
  /** Seconds since any keyboard, mouse or trackpad input. */
  readonly inputIdleSeconds: number;
  readonly locked: boolean;
  readonly displaysOnline: number;
  readonly displaysAwake: number;
  /** Display-sleep assertions that look like media playback. */
  readonly video: readonly VideoAssertion[];
  /** Null when the audio system did not answer in time. */
  readonly microphone: boolean | null;
  /** Null when the camera system did not answer in time. */
  readonly camera: boolean | null;
  readonly screenSharing: boolean;
  readonly source: "system" | "fixture";
  readonly elapsedMs: number;
  /** Fixture-only overrides for placement tests. */
  readonly load?: { readonly local?: number; readonly localFreePermits?: number; readonly remote?: number | null };
};

export type PresenceState = "away" | "idle" | "typing" | "video" | "call";

export type Presence = {
  readonly busy: boolean;
  readonly facts: PresenceFacts;
  readonly reason: string;
  readonly state: PresenceState;
};

export type SampleOptions = {
  /** Ignore display-sleep assertions from processes started at or after this time (ms since epoch). */
  readonly ignoreProcessesStartedAfter?: number;
};

export type PresenceProbe = {
  readonly sample: (options?: SampleOptions) => Promise<PresenceFacts>;
};

/** Utilities that keep the display awake on purpose; never a sign of video. */
export const keepAwakeProcesses: ReadonlySet<string> = new Set([
  "Amphetamine",
  "Amphetamine Enhancer",
  "caffeinate",
  "KeepingYouAwake",
  "Lungo",
  "powerd",
  "Theine",
]);

/** Assertions owned by a process under one of these come from agents and builds. */
export const agentProcesses: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "cursor-agent",
  "host-run",
  "ohd",
  "xcodebuild",
]);

const displaySleepTypes = new Set(["PreventUserIdleDisplaySleep", "NoDisplaySleepAssertion"]);
const assertionLine = /^\s*pid (\d+)\((.*?)\): \[0x[0-9a-f]+\] [\d:]+ (\w+) named: "(.*)"/u;

export type ProcessInfo = { readonly name: string; readonly ppid: number; readonly startedAtMs: number };

/** Display-sleep assertions from `pmset -g assertions`, minus keep-awake tools and agents' own. */
export function videoAssertions(
  text: string,
  processInfo: (pid: number) => ProcessInfo | null,
  options: SampleOptions = {},
): VideoAssertion[] {
  const found: VideoAssertion[] = [];
  let listing = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("Listed by owning process")) {
      listing = true;
      continue;
    }
    if (line.startsWith("Kernel Assertions")) break;
    if (!listing) continue;
    const match = assertionLine.exec(line);
    if (match === null || !displaySleepTypes.has(match[3]!)) continue;
    const pid = Number(match[1]);
    const name = match[4]!;
    const owner = processInfo(pid);
    const processName = owner?.name ?? match[2]!;
    if (keepAwakeProcesses.has(match[2]!) || keepAwakeProcesses.has(processName)) continue;
    if (
      options.ignoreProcessesStartedAfter !== undefined
      && owner !== null
      && owner.startedAtMs >= options.ignoreProcessesStartedAfter
    ) continue;
    if (descendsFromAgent(pid, processInfo)) continue;
    found.push({ name, pid, process: match[2]! });
  }
  return found;
}

function descendsFromAgent(pid: number, processInfo: (pid: number) => ProcessInfo | null): boolean {
  let current = pid;
  for (let depth = 0; depth < 64 && current > 1; depth += 1) {
    const info = processInfo(current);
    if (info === null) return false;
    if (agentProcesses.has(info.name)) return true;
    current = info.ppid;
  }
  return false;
}

function minutesText(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Turns raw facts into one state with a short reason. */
export function classifyPresence(facts: PresenceFacts, keyIdleMinutes: number): Presence {
  const result = (state: PresenceState, reason: string): Presence => ({
    busy: state === "typing" || state === "video" || state === "call",
    facts,
    reason,
    state,
  });
  if (facts.locked) return result("away", "screen locked");
  if (facts.displaysOnline === 0) return result("away", "lid closed with no display");
  if (facts.displaysAwake === 0) return result("away", "display asleep");
  if (facts.camera) return result("call", "camera in use");
  if (facts.camera === null || facts.microphone === null) {
    // Unknown counts as a call: a run that might disturb one is not worth the risk.
    return result("call", "microphone or camera state unknown");
  }
  if (facts.screenSharing) return result("call", "screen sharing");
  if (facts.microphone) return result("call", "microphone in use");
  const video = facts.video[0];
  if (video !== undefined) return result("video", `video playing in ${video.process}`);
  if (facts.keyIdleSeconds < keyIdleMinutes * 60) {
    return result("typing", `typed ${minutesText(facts.keyIdleSeconds)} ago`);
  }
  return result("idle", `owner idle ${minutesText(facts.keyIdleSeconds)}, no video or call`);
}

// ---- system probe (macOS) ----

function openNative() {
  const cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
    CGDisplayIsAsleep: { args: [FFIType.u32], returns: FFIType.bool },
    CGEventSourceSecondsSinceLastEventType: { args: [FFIType.i32, FFIType.u32], returns: FFIType.f64 },
    CGGetOnlineDisplayList: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CGSessionCopyCurrentDictionary: { args: [], returns: FFIType.ptr },
  });
  const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFBooleanGetValue: { args: [FFIType.ptr], returns: FFIType.bool },
    CFDictionaryGetValue: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
  });
  const lockedKey = cf.symbols.CFStringCreateWithCString(null, ptr(Buffer.from("CGSSessionScreenIsLocked\0")), 0x0800_0100);
  return { cf, cg, lockedKey };
}

const procPidTbsdInfo = 3;
const procBsdInfoSize = 136;
let libproc: ReturnType<typeof openLibproc> | null | undefined;

function openLibproc() {
  return dlopen("/usr/lib/libproc.dylib", {
    proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
}

function proc() {
  if (libproc === undefined) {
    try {
      libproc = process.platform === "darwin" ? openLibproc() : null;
    } catch {
      libproc = null;
    }
  }
  return libproc;
}

/** Name, parent and start time of a process (macOS), or null. */
export function darwinProcessInfo(pid: number): ProcessInfo | null {
  const library = proc();
  if (library === null || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const buffer = Buffer.alloc(procBsdInfoSize);
  if (library.symbols.proc_pidinfo(pid, procPidTbsdInfo, 0n, ptr(buffer), procBsdInfoSize) < procBsdInfoSize) return null;
  const text = (offset: number, length: number): string => {
    const raw = buffer.subarray(offset, offset + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? length : end).toString("utf8");
  };
  const longName = text(64, 32);
  return {
    name: longName === "" ? text(48, 16) : longName,
    ppid: buffer.readUInt32LE(16),
    startedAtMs: Number(buffer.readBigUInt64LE(120)) * 1_000 + Math.floor(Number(buffer.readBigUInt64LE(128)) / 1_000),
  };
}

/** All descendants of `root` (macOS), deepest last. */
export function descendantPids(root: number): number[] {
  const library = proc();
  if (library === null) return [];
  const found: number[] = [];
  const queue = [root];
  const buffer = new Int32Array(4_096);
  while (queue.length > 0 && found.length < 4_096) {
    const parent = queue.shift()!;
    const bytes = library.symbols.proc_listchildpids(parent, ptr(buffer), buffer.byteLength);
    const count = bytes <= 0 ? 0 : Math.min(buffer.length, bytes);
    for (const pid of buffer.subarray(0, count)) {
      if (pid > 0 && !found.includes(pid)) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found;
}

let sysctl: ((name: ReturnType<typeof ptr>, length: number, old: ReturnType<typeof ptr> | null, oldLength: ReturnType<typeof ptr>) => number) | null | undefined;

/** Whether a process with this short name (`p_comm`, at most 16 bytes) runs: one sysctl for the whole table. */
export function processRunning(name: string): boolean {
  if (sysctl === undefined) {
    try {
      const library = dlopen("/usr/lib/libSystem.B.dylib", {
        sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      });
      sysctl = (mib, length, old, oldLength) => library.symbols.sysctl(mib, length, old, oldLength, null, 0n);
    } catch {
      sysctl = null;
    }
  }
  if (sysctl === null) return false;
  const kinfoProcSize = 648;
  const commOffset = 243;
  const mib = new Int32Array([1, 14, 0]); // CTL_KERN, KERN_PROC, KERN_PROC_ALL
  const length = new BigUint64Array(1);
  if (sysctl(ptr(mib), 3, null, ptr(length)) !== 0) return false;
  const table = Buffer.alloc(Number(length[0]) + 64 * kinfoProcSize);
  length[0] = BigInt(table.byteLength);
  if (sysctl(ptr(mib), 3, ptr(table), ptr(length)) !== 0) return false;
  const wanted = Buffer.from(name.slice(0, 16));
  for (let offset = 0; offset + kinfoProcSize <= Number(length[0]); offset += kinfoProcSize) {
    const comm = table.subarray(offset + commOffset, offset + commOffset + 17);
    if (comm.subarray(0, wanted.length).equals(wanted) && comm[wanted.length] === 0) return true;
  }
  return false;
}

function readAssertions(): Promise<string> {
  return new Promise((resolveText) => {
    const child = spawn("/usr/bin/pmset", ["-g", "assertions"], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
    child.stdout.on("data", (chunk) => { text += String(chunk); });
    child.once("error", () => { clearTimeout(timer); resolveText(""); });
    child.once("close", () => { clearTimeout(timer); resolveText(text); });
  });
}

type DeviceWorker = { pending: Promise<DeviceState | null> | null; worker: Worker | null };

/** Deadline for the microphone and camera flags; past it they count as unknown. */
const deviceDeadlineMilliseconds = 2_000;

function readDevicesInWorker(state: DeviceWorker): Promise<DeviceState | null> {
  if (state.pending !== null) return state.pending;
  if (state.worker === null) {
    try {
      state.worker = new Worker(new URL("./presence-devices.ts", import.meta.url).href);
      state.worker.unref();
    } catch {
      return Promise.resolve(null);
    }
  }
  const worker = state.worker;
  const answer = new Promise<DeviceState | null>((resolveState) => {
    worker.onmessage = (event: MessageEvent<{ ok: boolean; state?: DeviceState }>) => {
      state.pending = null;
      resolveState(event.data.ok && event.data.state !== undefined ? event.data.state : null);
    };
    worker.postMessage(null);
  });
  state.pending = answer;
  // A slow answer stays pending for the next sample; this one moves on without it.
  return Promise.race([
    answer,
    new Promise<null>((resolveLate) => {
      const timer = setTimeout(() => resolveLate(null), deviceDeadlineMilliseconds);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
}

function systemProbe(): PresenceProbe {
  const native = openNative();
  const worker: DeviceWorker = { pending: null, worker: null };
  let sharingCached = false;
  let sharingCheckedAt = Number.NEGATIVE_INFINITY;
  return {
    sample: async (options = {}) => {
      const started = performance.now();
      const assertions = readAssertions();
      const devices = readDevicesInWorker(worker);
      const cg = native.cg.symbols;
      // HID system state counts hardware input only; 10 is key down, 12 flags changed, ~0 any input.
      const keyIdleSeconds = Math.min(
        cg.CGEventSourceSecondsSinceLastEventType(1, 10),
        cg.CGEventSourceSecondsSinceLastEventType(1, 12),
      );
      const inputIdleSeconds = cg.CGEventSourceSecondsSinceLastEventType(1, 0xffff_ffff);
      const displays = new Uint32Array(32);
      const count = new Uint32Array(1);
      cg.CGGetOnlineDisplayList(32, ptr(displays), ptr(count));
      const online = [...displays.subarray(0, count[0]!)];
      let locked = false;
      const session = cg.CGSessionCopyCurrentDictionary();
      if (session !== null) {
        const value = native.cf.symbols.CFDictionaryGetValue(session, native.lockedKey);
        locked = value !== null && native.cf.symbols.CFBooleanGetValue(value);
        native.cf.symbols.CFRelease(session);
      }
      const deviceState = await devices;
      // The process-table scan is the costliest read; a share lasts minutes, so reuse it for 10 s.
      if (performance.now() - sharingCheckedAt > 10_000) {
        sharingCached = processRunning("screensharingd");
        sharingCheckedAt = performance.now();
      }
      const screenSharing = sharingCached;
      const video = videoAssertions(await assertions, darwinProcessInfo, options);
      return {
        camera: deviceState?.camera ?? null,
        displaysAwake: online.filter((id) => !cg.CGDisplayIsAsleep(id)).length,
        displaysOnline: online.length,
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
        inputIdleSeconds,
        keyIdleSeconds,
        locked,
        microphone: deviceState?.microphone ?? null,
        screenSharing,
        source: "system",
        video,
      };
    },
  };
}

const idleFixture: Omit<PresenceFacts, "elapsedMs" | "source"> = {
  camera: false,
  displaysAwake: 1,
  displaysOnline: 1,
  inputIdleSeconds: 3_600,
  keyIdleSeconds: 3_600,
  locked: false,
  microphone: false,
  screenSharing: false,
  video: [],
};

/** Test stand-in: a JSON file of facts, reread on every sample. */
function fixtureProbe(path: string): PresenceProbe {
  return {
    sample: async () => {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PresenceFacts>;
      return { ...idleFixture, ...parsed, elapsedMs: 0, source: "fixture" };
    },
  };
}

let shared: PresenceProbe | null | undefined;

/**
 * The presence probe for this process, or null where it cannot run.
 * `LOCAL_EFFICIENCY_PRESENCE_FIXTURE=ABSOLUTE-PATH` substitutes a facts file (tests only).
 */
export function presenceProbe(environment: Readonly<NodeJS.ProcessEnv> = process.env): PresenceProbe | null {
  const fixture = environment.LOCAL_EFFICIENCY_PRESENCE_FIXTURE;
  if (fixture !== undefined && fixture !== "") return fixtureProbe(fixture);
  if (shared !== undefined) return shared;
  try {
    shared = process.platform === "darwin" ? systemProbe() : null;
  } catch {
    shared = null;
  }
  return shared;
}

// ---- priority (macOS) ----

let setPriority: ((which: number, who: number, priority: number) => number) | null | undefined;

/**
 * Moves processes into or out of the background band (PRIO_DARWIN_BG), as
 * `taskpolicy -b/-B -p` does: lower CPU priority, efficiency cores and
 * throttled disk I/O while the owner is using the Mac. Returns how many
 * changed.
 */
export function setBackground(pids: readonly number[], background: boolean): number {
  if (setPriority === undefined) {
    try {
      const library = dlopen("/usr/lib/libSystem.B.dylib", {
        setpriority: { args: [FFIType.i32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
      });
      setPriority = (which, who, priority) => library.symbols.setpriority(which, who, priority);
    } catch {
      setPriority = null;
    }
  }
  if (setPriority === null) return 0;
  const prioDarwinProcess = 4;
  const prioDarwinBackground = 0x1000;
  let changed = 0;
  for (const pid of pids) {
    if (setPriority(prioDarwinProcess, pid, background ? prioDarwinBackground : 0) === 0) changed += 1;
  }
  return changed;
}

// ---- load ----

export type LoadSample = { readonly cores: number; readonly load: number };

/** One-minute load per core from `remote load` output, or null. */
export function parseRemoteLoad(text: string): number | null {
  const fields = new Map(text.trim().split("\n").map((line) => line.split("\t") as [string, string]));
  const cores = Number(fields.get("cores"));
  const load = Number(fields.get("load"));
  if (!Number.isFinite(cores) || cores <= 0 || !Number.isFinite(load) || load < 0) return null;
  return load / cores;
}
