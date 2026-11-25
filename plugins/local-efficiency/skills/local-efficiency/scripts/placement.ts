/**
 * Where a run goes on a workstation the owner also uses: here while they
 * are idle or away, on the other Mac while they type, watch video or are on
 * a call.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname, loadavg, availableParallelism } from "node:os";

import {
  type ForwardDependencies,
  type PresenceConfig,
  type RemoteForwardConfig,
  remoteCall,
  remoteScriptPath,
} from "./mac-ui-forward";
import {
  classifyPresence,
  darwinProcessInfo,
  descendantPids,
  type Presence,
  type PresenceProbe,
  type SampleOptions,
  parseRemoteLoad,
  setBackground,
} from "./presence";

export type Placement = { readonly here: boolean; readonly reason: string };

export function thisHostName(): string {
  return hostname().split(".")[0] || "this Mac";
}

/** UI work runs here only while the owner is idle at an unlocked, awake screen. */
export function placeMacUi(presence: Presence): Placement {
  if (presence.state === "idle") return { here: true, reason: presence.reason };
  if (presence.state === "away") return { here: false, reason: `${presence.reason}; UI tests need an unlocked, awake screen` };
  return { here: false, reason: presence.reason };
}

export type Capacity = {
  /** CPU permits free in this Mac's scheduler. */
  readonly localFreePermits: number;
  /** One-minute load per core here. */
  readonly localLoadPerCore: number;
  /** Permits this run needs. */
  readonly needed: number;
  /** One-minute load per core on the other Mac, or null when it did not answer. */
  readonly remoteLoadPerCore: number | null;
  readonly remoteName: string;
};

const spareLoadPerCore = 0.5;

function load(value: number): string {
  return `${value.toFixed(1)}/core`;
}

/** Heavy compute stays here when the owner is not using the Mac and it has room to spare. */
export function placeCompute(presence: Presence, capacity: Capacity): Placement {
  if (presence.busy) return { here: false, reason: presence.reason };
  const owner = presence.state === "away" ? `owner away (${presence.reason})` : presence.reason;
  if (capacity.localFreePermits < capacity.needed) {
    return {
      here: false,
      reason: `${owner}, but only ${capacity.localFreePermits} of the ${capacity.needed} permits it needs are free here`,
    };
  }
  if (capacity.remoteLoadPerCore === null) {
    return { here: true, reason: `${owner}; ${capacity.remoteName} did not report its load` };
  }
  const loads = `load ${load(capacity.localLoadPerCore)} here, ${load(capacity.remoteLoadPerCore)} on ${capacity.remoteName}`;
  if (capacity.localLoadPerCore <= capacity.remoteLoadPerCore || capacity.localLoadPerCore < spareLoadPerCore) {
    return { here: true, reason: `${owner}; ${loads}` };
  }
  return { here: false, reason: `${owner}, but ${capacity.remoteName} is less loaded (${loads})` };
}

/** The other Mac's load per core over the existing ssh channel, or null. */
export function remoteLoadPerCore(deps: ForwardDependencies, config: RemoteForwardConfig): number | null {
  if (!existsSync(remoteScriptPath)) return null;
  const result = remoteCall(deps, config, readFileSync(remoteScriptPath, "utf8"), "load", [], 15_000);
  if (result.status !== 0) return null;
  return parseRemoteLoad(result.stdout.toString("utf8"));
}

export function localLoadPerCore(): number {
  return (loadavg()[0] ?? 0) / Math.max(1, availableParallelism());
}

export async function samplePresence(
  probe: PresenceProbe,
  config: PresenceConfig,
  options: SampleOptions = {},
): Promise<Presence> {
  return classifyPresence(await probe.sample(options), config.keyIdleMinutes);
}

/** A running command as a watcher sees it. */
export type WatchedRun = {
  readonly pid: number;
  /** TERM the command's process group now, KILL it after `graceMs`. */
  readonly stop: (graceMs: number) => void;
};

export type Watcher = (run: WatchedRun) => () => void;

/** What a UI run here learned while it ran. */
export type HandoffState = {
  /** Set once the owner came back and the run was stopped. */
  stoppedFor: Presence | null;
  /** Descendants seen while it ran, with their start times. */
  readonly seen: Map<number, number>;
};

/**
 * Stops a UI run here as soon as the owner is back (typing, video, a call,
 * or the screen locks), recording why in `state`.
 */
export function macUiHandoffWatcher(
  probe: PresenceProbe,
  config: PresenceConfig,
  state: HandoffState,
  log: (line: string) => void,
  processStart: (pid: number) => number | null = (pid) => darwinProcessInfo(pid)?.startedAtMs ?? null,
): Watcher {
  return (run) => {
    const startedAt = Date.now();
    let sampling = false;
    const timer = setInterval(() => {
      if (state.stoppedFor !== null || sampling) return;
      sampling = true;
      for (const pid of descendantPids(run.pid)) {
        if (state.seen.has(pid)) continue;
        const started = processStart(pid);
        if (started !== null) state.seen.set(pid, started);
      }
      // Media the run itself starts (an app under test) is not the owner watching.
      void samplePresence(probe, config, { ignoreProcessesStartedAfter: startedAt - 1_000 })
        .then((presence) => {
          if (state.stoppedFor !== null || presence.state === "idle") return;
          state.stoppedFor = presence;
          log(`[host-run] ${presence.reason}: stopping this run here (TERM, then KILL after ${config.graceSeconds}s)`);
          run.stop(config.graceSeconds * 1_000);
        })
        .catch((error: unknown) => {
          log(`[host-run] presence check failed (${error instanceof Error ? error.message : String(error)}); continuing`);
        })
        .finally(() => { sampling = false; });
    }, config.pollSeconds * 1_000);
    return () => clearInterval(timer);
  };
}

/**
 * Keeps heavy compute here out of the owner's way: while they are busy its
 * whole process tree runs in the background band, and it returns to normal
 * priority when they are idle or away again. It never stops the build.
 */
export function computeYieldWatcher(
  probe: PresenceProbe,
  config: PresenceConfig,
  label: string,
  log: (line: string) => void,
  initiallyBusy: Presence | null = null,
  pollMilliseconds = Math.max(config.pollSeconds, 5) * 1_000,
): Watcher {
  return (run) => {
    let background = false;
    let sampling = false;
    const tree = (): number[] => [run.pid, ...descendantPids(run.pid)];
    const apply = (presence: Presence): void => {
      if (presence.busy) {
        // New children start at normal priority; move each one as it appears.
        setBackground(tree(), true);
        if (!background) log(`[host-run] owner is busy (${presence.reason}); ${label} continues at background priority`);
        background = true;
      } else if (background) {
        setBackground(tree(), false);
        background = false;
        log(`[host-run] ${presence.reason}; ${label} is back at normal priority`);
      }
    };
    // The child may not have exec'd yet; apply again once it has.
    let settle: ReturnType<typeof setTimeout> | undefined;
    if (initiallyBusy !== null) {
      apply(initiallyBusy);
      settle = setTimeout(() => { if (background) setBackground(tree(), true); }, 250);
    }
    const timer = setInterval(() => {
      if (sampling) return;
      sampling = true;
      void samplePresence(probe, config)
        .then(apply)
        .catch(() => {})
        .finally(() => { sampling = false; });
    }, pollMilliseconds);
    return () => {
      clearInterval(timer);
      if (settle !== undefined) clearTimeout(settle);
    };
  };
}

/**
 * TERM descendants of a stopped run that left its process group (a helper
 * that called setsid, say). A pid is signalled only while it still has the
 * start time recorded for it, so a reused pid is never touched.
 */
export function terminateLeftovers(
  seen: ReadonlyMap<number, number>,
  processStart: (pid: number) => number | null = (pid) => darwinProcessInfo(pid)?.startedAtMs ?? null,
  signal: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"),
): number {
  let signalled = 0;
  for (const [pid, startedAt] of seen) {
    if (processStart(pid) !== startedAt) continue;
    try {
      signal(pid);
      signalled += 1;
    } catch {
      // already gone
    }
  }
  return signalled;
}
