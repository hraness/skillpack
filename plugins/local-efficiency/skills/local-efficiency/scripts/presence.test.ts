import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type PresenceFacts,
  type ProcessInfo,
  classifyPresence,
  parseRemoteLoad,
  presenceProbe,
  videoAssertions,
} from "./presence";

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

const video = { name: "Video Wake Lock", pid: 700, process: "Google Chrome Helper" };

describe("presence classification", () => {
  test("each signal maps to one state with a reason, in priority order", () => {
    const cases: [Partial<PresenceFacts>, string, string][] = [
      [{}, "idle", "owner idle 15m, no video or call"],
      [{ keyIdleSeconds: 7_500 }, "idle", "owner idle 2h05m, no video or call"],
      [{ keyIdleSeconds: 42 }, "typing", "typed 42s ago"],
      [{ keyIdleSeconds: 240 }, "typing", "typed 4m ago"],
      // Mouse-only use (browsing) does not count as typing.
      [{ inputIdleSeconds: 1, keyIdleSeconds: 600 }, "idle", "owner idle 10m, no video or call"],
      [{ video: [video] }, "video", "video playing in Google Chrome Helper"],
      [{ microphone: true }, "call", "microphone in use"],
      [{ camera: true, microphone: true }, "call", "camera in use"],
      [{ screenSharing: true }, "call", "screen sharing"],
      [{ microphone: null }, "call", "microphone or camera state unknown"],
      [{ camera: null }, "call", "microphone or camera state unknown"],
      [{ locked: true, keyIdleSeconds: 1, video: [video] }, "away", "screen locked"],
      [{ displaysAwake: 0 }, "away", "display asleep"],
      [{ displaysAwake: 0, displaysOnline: 0 }, "away", "lid closed with no display"],
    ];
    for (const [facts, state, reason] of cases) {
      const presence = classifyPresence({ ...idle, ...facts }, 5);
      expect({ reason: presence.reason, state: presence.state }).toEqual({ reason, state });
      expect(presence.busy).toBe(state === "typing" || state === "video" || state === "call");
    }
    expect(classifyPresence({ ...idle, keyIdleSeconds: 400 }, 10).state).toBe("typing");
  });
});

const assertions = [
  "2026-11-25 14:13:07 -0400 ",
  "Assertion status system-wide:",
  "   PreventUserIdleDisplaySleep    1",
  "Listed by owning process:",
  "   pid 1908(Amphetamine): [0x000009e900058f61] 54:20:25 PreventUserIdleDisplaySleep named: \"Amphetamine (Single-Use - Display)\"  ",
  "   pid 58144(caffeinate): [0x000305cc00019588] 00:01:09 PreventUserIdleDisplaySleep named: \"caffeinate command-line tool\"  ",
  "\tDetails: caffeinate asserting for 300 secs",
  "   pid 1669(Google Chrome): [0x0002e820000188a5] 02:07:46 NoIdleSleepAssertion named: \"WebRTC has active PeerConnections\"  ",
  "   pid 700(Google Chrome Helper): [0x0002e820000188a6] 00:10:00 PreventUserIdleDisplaySleep named: \"Video Wake Lock\"  ",
  "   pid 800(Simulator): [0x0002e820000188a7] 00:00:10 PreventUserIdleDisplaySleep named: \"app under test\"  ",
  "   pid 900(Chromium): [0x0002e820000188a8] 00:00:10 NoDisplaySleepAssertion named: \"Video Wake Lock\"  ",
  "   pid 950(IINA): [0x0002e820000188a9] 00:00:10 PreventUserIdleDisplaySleep named: \"playing\"  ",
  "Kernel Assertions: 0x4=USB",
  "   id=500  level=255 0x4=USB mod=1/1/70 description=com.apple.usb.externaldevice",
].join("\n");

describe("video assertions", () => {
  const table = new Map<number, ProcessInfo>([
    [1, { name: "launchd", ppid: 0, startedAtMs: 0 }],
    [700, { name: "Google Chrome Helper", ppid: 1669, startedAtMs: 1_000 }],
    [1669, { name: "Google Chrome", ppid: 1, startedAtMs: 1_000 }],
    [800, { name: "Simulator", ppid: 1, startedAtMs: 50_000 }],
    // An agent's own browser: Chromium under xcodebuild under claude.
    [900, { name: "Chromium", ppid: 910, startedAtMs: 1_000 }],
    [910, { name: "node", ppid: 920, startedAtMs: 1_000 }],
    [920, { name: "claude", ppid: 1, startedAtMs: 1_000 }],
    [950, { name: "IINA", ppid: 1, startedAtMs: 1_000 }],
  ]);
  const info = (pid: number): ProcessInfo | null => table.get(pid) ?? null;

  test("counts display-sleep locks from media apps, not keep-awake tools or agents", () => {
    expect(videoAssertions(assertions, info).map((entry) => entry.process))
      .toEqual(["Google Chrome Helper", "Simulator", "IINA"]);
  });

  test("a run here ignores assertions from processes it started", () => {
    expect(videoAssertions(assertions, info, { ignoreProcessesStartedAfter: 40_000 }).map((entry) => entry.process))
      .toEqual(["Google Chrome Helper", "IINA"]);
  });

  test("no listing, no video", () => {
    expect(videoAssertions("", info)).toEqual([]);
    expect(videoAssertions("Assertion status system-wide:\n   PreventUserIdleDisplaySleep 0\n", info)).toEqual([]);
  });
});

describe("presence probe", () => {
  test("a fixture file stands in for the system and is reread on every sample", async () => {
    const root = mkdtempSync(join(tmpdir(), "le-presence-"));
    try {
      const path = join(root, "facts.json");
      writeFileSync(path, JSON.stringify({ keyIdleSeconds: 30 }));
      const probe = presenceProbe({ LOCAL_EFFICIENCY_PRESENCE_FIXTURE: path })!;
      expect(classifyPresence(await probe.sample(), 5).state).toBe("typing");
      writeFileSync(path, JSON.stringify({ locked: true }));
      const facts = await probe.sample();
      expect(facts.source).toBe("fixture");
      expect(classifyPresence(facts, 5).state).toBe("away");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test.skipIf(process.platform !== "darwin")("reads this Mac without a prompt, quickly once warm", async () => {
    const probe = presenceProbe({})!;
    expect(probe).not.toBeNull();
    await probe.sample();
    const facts = await probe.sample();
    expect(facts.source).toBe("system");
    expect(facts.keyIdleSeconds).toBeGreaterThanOrEqual(0);
    expect(facts.inputIdleSeconds).toBeLessThanOrEqual(facts.keyIdleSeconds + 1);
    expect(typeof facts.locked).toBe("boolean");
    expect(facts.displaysAwake).toBeLessThanOrEqual(facts.displaysOnline);
    // Loose bound: a loaded CI runner is slower than a workstation.
    expect(facts.elapsedMs).toBeLessThan(3_000);
  }, 30_000);
});

describe("remote load", () => {
  test("parses cores and load into load per core", () => {
    expect(parseRemoteLoad("cores\t16\nload\t8.00\n")).toBe(0.5);
    expect(parseRemoteLoad("cores\t0\nload\t1\n")).toBeNull();
    expect(parseRemoteLoad("load\t1\n")).toBeNull();
    expect(parseRemoteLoad("")).toBeNull();
  });
});
