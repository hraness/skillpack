import { describe, expect, test } from "bun:test";

import type { PresenceConfig } from "./mac-ui-forward";
import {
  type Capacity,
  type HandoffState,
  computeYieldWatcher,
  macUiHandoffWatcher,
  placeCompute,
  placeMacUi,
  terminateLeftovers,
} from "./placement";
import { type PresenceFacts, type PresenceProbe, classifyPresence } from "./presence";

const idle: PresenceFacts = {
  camera: false,
  displaysAwake: 1,
  displaysOnline: 1,
  elapsedMs: 0,
  inputIdleSeconds: 900,
  keyIdleSeconds: 900,
  locked: false,
  microphone: false,
  screenSharing: false,
  source: "fixture",
  video: [],
};

const presence = (facts: Partial<PresenceFacts>) => classifyPresence({ ...idle, ...facts }, 5);
const typing = { keyIdleSeconds: 20 };
const watching = { video: [{ name: "Video Wake Lock", pid: 7, process: "IINA" }] };
const onCall = { microphone: true };
const locked = { locked: true };

const roomy: Capacity = { localFreePermits: 6, localLoadPerCore: 0.3, needed: 3, remoteLoadPerCore: 2, remoteName: "hra2" };

describe("placement decisions", () => {
  test("UI work runs here only while the owner is idle at an awake, unlocked screen", () => {
    expect(placeMacUi(presence({}))).toEqual({ here: true, reason: "owner idle 15m, no video or call" });
    expect(placeMacUi(presence(typing))).toEqual({ here: false, reason: "typed 20s ago" });
    expect(placeMacUi(presence(watching))).toEqual({ here: false, reason: "video playing in IINA" });
    expect(placeMacUi(presence(onCall))).toEqual({ here: false, reason: "microphone in use" });
    expect(placeMacUi(presence(locked))).toEqual({
      here: false,
      reason: "screen locked; UI tests need an unlocked, awake screen",
    });
    expect(placeMacUi(presence({ displaysAwake: 0 })).here).toBe(false);
  });

  test("heavy compute stays here when the owner is idle or away and this Mac has room", () => {
    const table: [Partial<PresenceFacts>, Partial<Capacity>, boolean, string][] = [
      [{}, {}, true, "owner idle 15m, no video or call; load 0.3/core here, 2.0/core on hra2"],
      [locked, {}, true, "owner away (screen locked); load 0.3/core here, 2.0/core on hra2"],
      [typing, {}, false, "typed 20s ago"],
      [watching, {}, false, "video playing in IINA"],
      [onCall, {}, false, "microphone in use"],
      [{}, { localFreePermits: 2 }, false, "owner idle 15m, no video or call, but only 2 of the 3 permits it needs are free here"],
      [{}, { localLoadPerCore: 1.5, remoteLoadPerCore: 0.4 }, false,
        "owner idle 15m, no video or call, but hra2 is less loaded (load 1.5/core here, 0.4/core on hra2)"],
      // A lightly loaded Mac keeps the run even when the other is lighter still.
      [{}, { localLoadPerCore: 0.4, remoteLoadPerCore: 0.1 }, true,
        "owner idle 15m, no video or call; load 0.4/core here, 0.1/core on hra2"],
      [{}, { localLoadPerCore: 3, remoteLoadPerCore: null }, true, "owner idle 15m, no video or call; hra2 did not report its load"],
    ];
    for (const [facts, capacity, here, reason] of table) {
      expect(placeCompute(presence(facts), { ...roomy, ...capacity })).toEqual({ here, reason });
    }
  });
});

function scriptedProbe(sequence: Partial<PresenceFacts>[]): PresenceProbe & { readonly calls: number } {
  let index = 0;
  return {
    get calls() { return index; },
    sample: async () => ({ ...idle, ...sequence[Math.min(index++, sequence.length - 1)] }),
  };
}

const fast: PresenceConfig = { graceSeconds: 1, keyIdleMinutes: 5, pollSeconds: 0.02, waitMinutes: 1 };

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
}

describe("watchers", () => {
  test("a UI run here is stopped once, with the grace period, when the owner starts typing", async () => {
    const probe = scriptedProbe([{}, {}, typing, watching]);
    const state: HandoffState = { seen: new Map(), stoppedFor: null };
    const stops: number[] = [];
    const lines: string[] = [];
    const unwatch = macUiHandoffWatcher(probe, fast, state, (line) => lines.push(line), () => 1)({
      pid: process.pid,
      stop: (grace) => stops.push(grace),
    });
    await until(() => state.stoppedFor !== null);
    await Bun.sleep(100);
    unwatch();
    expect(state.stoppedFor?.reason).toBe("typed 20s ago");
    expect(stops).toEqual([1_000]);
    expect(lines).toEqual(["[host-run] typed 20s ago: stopping this run here (TERM, then KILL after 1s)"]);
  });

  test("a UI run here keeps going while the owner stays idle", async () => {
    const probe = scriptedProbe([{}]);
    const state: HandoffState = { seen: new Map(), stoppedFor: null };
    const stops: number[] = [];
    const unwatch = macUiHandoffWatcher(probe, fast, state, () => {}, () => 1)({ pid: process.pid, stop: (g) => stops.push(g) });
    await until(() => probe.calls >= 5);
    unwatch();
    expect(state.stoppedFor).toBeNull();
    expect(stops).toEqual([]);
  });

  test("heavy compute drops to background priority while the owner is busy and comes back when idle", async () => {
    const probe = scriptedProbe([typing, typing, {}, {}]);
    const lines: string[] = [];
    let stopped = false;
    const unwatch = computeYieldWatcher(probe, fast, "build", (line) => lines.push(line), null, 20)({
      pid: 999_999_999,
      stop: () => { stopped = true; },
    });
    await until(() => lines.length >= 2);
    unwatch();
    expect(stopped).toBe(false);
    expect(lines).toEqual([
      "[host-run] owner is busy (typed 20s ago); build continues at background priority",
      "[host-run] owner idle 15m, no video or call; build is back at normal priority",
    ]);
  });

  test("leftover processes are signalled only while their start time still matches", () => {
    const signalled: number[] = [];
    const now = new Map([[10, 100], [11, 200], [12, 300]]);
    const count = terminateLeftovers(
      new Map([[10, 100], [11, 111], [12, 300], [13, 400]]),
      (pid) => now.get(pid) ?? null,
      (pid) => { signalled.push(pid); },
    );
    expect(signalled).toEqual([10, 12]);
    expect(count).toBe(2);
  });
});
