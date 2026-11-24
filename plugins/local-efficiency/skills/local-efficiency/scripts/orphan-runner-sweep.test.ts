import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";

import {
  applySweep,
  formatSelection,
  parseRunnerPs,
  parseSweepArguments,
  selectCandidates,
  survivorHint,
  systemEffects,
  testRunnerKind,
  type Candidate,
  type RunnerProcess,
  type SweepEffects,
  type SweepSnapshot,
} from "./orphan-runner-sweep";

const hour = 3_600;
const uid = 501;
const nodeTestChild = "/opt/homebrew/Cellar/node@24/24.20.0/bin/node --test-concurrency=0 --test-isolation=process --test-timeout=0 /w/task/runner/test/codex-interactive.test.mjs";

function row(pid: number, overrides: Partial<RunnerProcess> = {}): RunnerProcess {
  return {
    ageSeconds: 20 * hour,
    command: nodeTestChild,
    cpuPercent: 80,
    cpuTime: "10:00.00",
    pgid: pid,
    pid,
    ppid: 1,
    rssKilobytes: 40 * 1024,
    uid,
    ...overrides,
  };
}

function snapshot(processes: RunnerProcess[], overrides: Partial<SweepSnapshot> = {}): SweepSnapshot {
  return {
    cwds: new Map([[100, "/private/tmp/task/wt"]]),
    holderPids: new Set(),
    processes,
    selfPid: 9_999,
    uid,
    ...overrides,
  };
}

describe("orphan-runner-sweep parsing", () => {
  test("parses ps rows on macOS and Linux formats", () => {
    expect(parseRunnerPs("  53667     1 53260   501 23:59:35   12.5  12816 15:02.19 /opt/node --test a.test.mjs\n")).toEqual([
      row(53667, {
        ageSeconds: 23 * hour + 59 * 60 + 35,
        command: "/opt/node --test a.test.mjs",
        cpuPercent: 12.5,
        cpuTime: "15:02.19",
        pgid: 53260,
        rssKilobytes: 12816,
      }),
    ]);
    expect(parseRunnerPs("1 0 1 0 1-00:00:00 0.0 100 00:00:01 /sbin/init\n")[0]?.ageSeconds).toBe(86_400);
  });

  test("recognises JS test runners only", () => {
    expect(testRunnerKind(nodeTestChild)).toBe("node-test");
    expect(testRunnerKind("node --test runner/test")).toBe("node-test");
    expect(testRunnerKind("node runner/test/codex-interactive.test.mjs")).toBe("test-file");
    expect(testRunnerKind("/usr/local/bin/bun test --timeout 5000")).toBe("bun-test");
    expect(testRunnerKind("/opt/u/.bun/bin/bun --bun test")).toBe("bun-test");
    expect(testRunnerKind("node /w/node_modules/vitest/dist/workers/forks.js")).toBe("vitest");
    expect(testRunnerKind("node /w/node_modules/.bin/vitest run")).toBe("vitest");
    expect(testRunnerKind("node /w/node_modules/jest-worker/build/workers/processChild.js")).toBe("jest");
    expect(testRunnerKind("node /w/server.js")).toBeNull();
    expect(testRunnerKind("bun run dev")).toBeNull();
    expect(testRunnerKind("/usr/libexec/testmanagerd")).toBeNull();
    expect(testRunnerKind("/Applications/Xcode.app/Contents/Developer/usr/bin/xctest a.xctest")).toBeNull();
    expect(testRunnerKind("python -m pytest a_test.py")).toBeNull();
  });

  test("parses flags", () => {
    expect(parseSweepArguments([])).toEqual({ apply: false, graceMilliseconds: 10_000, json: false, minimumAgeSeconds: 2 * hour });
    expect(parseSweepArguments(["--apply", "--min-age=30m", "--grace", "5s", "--json"]))
      .toEqual({ apply: true, graceMilliseconds: 5_000, json: true, minimumAgeSeconds: 30 * 60 });
    expect(parseSweepArguments(["--kill"])).toEqual({ error: "unknown argument: --kill" });
    expect(parseSweepArguments(["--min-age=soon"])).toHaveProperty("error");
  });
});

describe("orphan-runner-sweep candidate selection", () => {
  test("selects old orphaned runners owned by this user", () => {
    const selection = selectCandidates(snapshot([
      row(100),
      row(101, { uid: 0 }),
      row(102, { ppid: 4_000 }),
      row(103, { command: "node /w/server.js" }),
      row(104, { ageSeconds: hour }),
      row(4_000, { command: "/bin/zsh", ppid: 1 }),
    ]));
    expect(selection.candidates.map((entry) => entry.pid)).toEqual([100]);
    expect(selection.candidates[0]?.cwd).toBe("/private/tmp/task/wt");
    expect(selection.skipped).toEqual([{ kind: "node-test", pid: 104, reason: "younger than the age threshold" }]);
  });

  test("honours a custom age threshold", () => {
    expect(selectCandidates(snapshot([row(104, { ageSeconds: hour })]), 30 * 60).candidates.map((entry) => entry.pid)).toEqual([104]);
  });

  test("leaves runners inside a live host-run lease alone", () => {
    const processes = [
      row(200, { command: "bun /x/host-run.ts --mode=shared -- bash", pgid: 200, ppid: 50 }),
      row(201, { command: "bash -c bun test", pgid: 201, ppid: 200 }),
      row(202, { command: "bun test", pgid: 201, ppid: 1 }),
      row(203, { pgid: 203 }),
    ];
    const selection = selectCandidates(snapshot(processes, { holderPids: new Set([203]) }));
    expect(selection.candidates).toEqual([]);
    expect(selection.skipped.map((entry) => [entry.pid, entry.reason])).toEqual([
      [202, "process group leader 201 is alive"],
      [203, "inside live host-run lease (holder pid 203)"],
    ]);
  });

  test("leaves groups that are still attached to a live tree or agent session alone", () => {
    const processes = [
      row(300, { pgid: 299 }),
      row(301, { command: "node worker.js", pgid: 299, ppid: 700 }),
      row(700, { command: "/opt/u/.local/bin/claude", pgid: 700, ppid: 1 }),
      row(310, { pgid: 309 }),
      row(311, { command: "node helper.js", pgid: 309, ppid: 1 }),
    ];
    const selection = selectCandidates(snapshot(processes));
    expect(selection.candidates.map((entry) => entry.pid)).toEqual([310]);
    expect(selection.skipped).toEqual([{ kind: "node-test", pid: 300, reason: "process group member 301 still has a live parent" }]);
  });

  test("never selects itself or its own ancestors", () => {
    const processes = [row(800, { pgid: 800 }), row(9_999, { command: "bun orphan-runner-sweep.ts", ppid: 800 })];
    const selection = selectCandidates(snapshot(processes));
    expect(selection.candidates).toEqual([]);
    expect(selection.skipped[0]?.reason).toBe("ancestor of this sweep");
  });

  test("dry-run output lists pid, age, cpu, cwd, and command", () => {
    const text = formatSelection(selectCandidates(snapshot([row(100)])), 2 * hour, false);
    expect(text).toContain("dry run; nothing was signalled");
    expect(text).toContain("pid 100\tnode-test\tage 20h00m\tcpu 80% (10:00.00)");
    expect(text).toContain("cwd /private/tmp/task/wt");
    expect(text).toContain("codex-interactive.test.mjs");
  });
});

type FakeProcess = { alive: boolean; command: string; ignoresTerm: boolean; token: string };

function fakeEffects(table: Map<number, FakeProcess>): { effects: SweepEffects; signals: [number, string][] } {
  const signals: [number, string][] = [];
  let clock = 0;
  const effects: SweepEffects = {
    describe: (pid) => {
      const entry = table.get(pid);
      return entry?.alive === true ? { command: entry.command, ppid: 1 } : null;
    },
    identity: (pid) => {
      const entry = table.get(pid);
      return entry?.alive === true ? { token: entry.token } : null;
    },
    now: () => clock,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      const entry = table.get(pid);
      if (entry === undefined || !entry.alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (!entry.ignoresTerm) entry.alive = false;
    },
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  };
  return { effects, signals };
}

function candidate(pid: number): Candidate {
  return {
    ageSeconds: 20 * hour,
    command: nodeTestChild,
    cpuPercent: 90,
    cpuTime: "1:00.00",
    cwd: "/w",
    kind: "node-test",
    pgid: pid,
    pid,
    rssKilobytes: 1,
  };
}

describe("orphan-runner-sweep --apply (SIGTERM only)", () => {
  test("terminates cooperative runners and reports survivors without escalating", async () => {
    const table = new Map<number, FakeProcess>([
      [1, { alive: true, command: nodeTestChild, ignoresTerm: false, token: "t1" }],
      [2, { alive: true, command: nodeTestChild, ignoresTerm: true, token: "t2" }],
    ]);
    const { effects, signals } = fakeEffects(table);
    const outcomes = await applySweep([candidate(1), candidate(2)], effects, 2_000);
    expect(signals).toEqual([[1, "SIGTERM"], [2, "SIGTERM"]]);
    expect(signals.every(([, signal]) => signal === "SIGTERM")).toBe(true);
    expect(outcomes).toEqual([
      { detail: "exited after SIGTERM", pid: 1, result: "stopped" },
      { detail: survivorHint.replaceAll("PID", "2"), pid: 2, result: "survived" },
    ]);
    expect(table.get(2)?.alive).toBe(true);
    expect(outcomes[1]?.detail).toContain("never sends SIGKILL");
  });

  test("does not signal a pid whose start token, command, or presence changed", async () => {
    const table = new Map<number, FakeProcess>([
      [3, { alive: true, command: "node /w/server.js", ignoresTerm: false, token: "t3" }],
      [4, { alive: false, command: nodeTestChild, ignoresTerm: false, token: "t4" }],
    ]);
    const { effects, signals } = fakeEffects(table);
    let reads = 0;
    const reused: SweepEffects = {
      ...effects,
      identity: (pid) => (pid === 5 ? { token: reads++ === 0 ? "old" : "new" } : effects.identity(pid)),
      describe: (pid) => (pid === 5 ? { command: nodeTestChild, ppid: 1 } : effects.describe(pid)),
    };
    const outcomes = await applySweep([candidate(3), candidate(4), candidate(5)], reused, 1_000);
    expect(signals).toEqual([]);
    expect(outcomes.map((entry) => [entry.pid, entry.result])).toEqual([[3, "skipped"], [4, "skipped"], [5, "skipped"]]);
  });

  test("a recycled pid after SIGTERM counts as stopped, not survived", async () => {
    const table = new Map<number, FakeProcess>([[6, { alive: true, command: nodeTestChild, ignoresTerm: true, token: "t6" }]]);
    const { effects } = fakeEffects(table);
    const recycling: SweepEffects = {
      ...effects,
      signal: (pid, signal) => {
        effects.signal(pid, signal);
        table.set(6, { alive: true, command: nodeTestChild, ignoresTerm: true, token: "other" });
      },
    };
    expect(await applySweep([candidate(6)], recycling, 1_000)).toEqual([
      { detail: "exited after SIGTERM", pid: 6, result: "stopped" },
    ]);
  });

  test("system effects refuse any signal other than SIGTERM", () => {
    expect(() => systemEffects().signal(1, "SIGKILL" as "SIGTERM")).toThrow("only sends SIGTERM");
  });

  test("leaves a real orphan that ignores SIGTERM running", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const pid = child.pid ?? 0;
      const real = systemEffects();
      const command = real.describe(pid)?.command ?? "";
      const effects: SweepEffects = { ...real, describe: (target) => {
        const description = real.describe(target);
        return description === null ? null : { ...description, ppid: 1 };
      } };
      const outcomes = await applySweep([{ ...candidate(pid), command }], effects, 600);
      expect(outcomes.map((entry) => entry.result)).toEqual(["survived"]);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });
});
