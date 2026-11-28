import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatHostStatus,
  hostStatusReport,
  overflowProfile,
  permitCapacity,
  readHolders,
  registerHolder,
  resolveHolderRoot,
  resolveOverflowStateRoot,
} from "./host-run";
import {
  defaultLendingConfig,
  freeMemoryFraction,
  headroomProbe,
  lendingConfig,
  lendingDecision,
  type LendingHolder,
} from "./lending";
import { validateThroughputEvent } from "./telemetry";

const now = new Date("2026-11-28T07:00:00.000Z");
const minutesAgo = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString();

function decide(input: {
  readonly freeMemoryFraction?: number | null;
  readonly holders?: readonly LendingHolder[];
  readonly idleCores: number;
  readonly permits?: number;
  readonly waiting?: readonly LendingHolder[];
}) {
  return lendingDecision({
    capacity: 6,
    config: defaultLendingConfig,
    headroom: { freeMemoryFraction: input.freeMemoryFraction ?? 0.7, idleCores: input.idleCores },
    holders: input.holders ?? [],
    hostParallelism: 18,
    now,
    permits: input.permits ?? 1,
    ...(input.waiting === undefined ? {} : { waiting: input.waiting }),
  });
}

describe("idle-permit lending decision", () => {
  test("lends when the cores for the run and the reserve are idle", () => {
    // One permit is 3 of 18 cores; the reserve keeps 20% (3.6 cores) idle.
    expect(decide({ idleCores: 6.6 })).toEqual({ lend: true, reason: "6.6 of 18 cores idle" });
    expect(decide({ idleCores: 6.5 }).lend).toBe(false);
    expect(decide({ idleCores: 9.6, permits: 2 }).lend).toBe(true);
    expect(decide({ idleCores: 9.5, permits: 2 }).reason).toBe("9.5 of 18 cores idle; borrowing needs 9.6");
  });

  test("never lends to or beside a whole-machine run", () => {
    expect(decide({ idleCores: 18, permits: 6 })).toEqual({ lend: false, reason: "a whole-machine run never borrows" });
    expect(decide({
      holders: [{ admittedAt: minutesAgo(5), permits: 6 }],
      idleCores: 18,
    })).toEqual({ lend: false, reason: "a whole-machine run holds this host" });
    // A whole-machine run still waiting for its permits stops new loans, so later runs cannot overtake it.
    expect(decide({
      idleCores: 18,
      waiting: [{ admittedAt: minutesAgo(1), permits: 6 }],
    })).toEqual({ lend: false, reason: "a whole-machine run is waiting for this host" });
  });

  test("counts a new borrower at its full share until the measurement catches up", () => {
    const fresh: LendingHolder = { admittedAt: minutesAgo(0.5), permits: 2, pool: "overflow" };
    const settled: LendingHolder = { admittedAt: minutesAgo(5), permits: 2, pool: "overflow" };
    const ordinary: LendingHolder = { admittedAt: minutesAgo(0.5), permits: 2 };
    expect(decide({ holders: [fresh], idleCores: 12 }).lend).toBe(false);
    expect(decide({ holders: [fresh], idleCores: 12.6 }).lend).toBe(true);
    expect(decide({ holders: [settled, ordinary], idleCores: 6.6 }).lend).toBe(true);
    expect(decide({ holders: [{ ...fresh, admittedAt: "not a time" }], idleCores: 12 }).lend).toBe(false);
  });

  test("needs free memory when the platform reports it", () => {
    expect(decide({ freeMemoryFraction: 0.2, idleCores: 18 }))
      .toEqual({ lend: false, reason: "20% of memory free; borrowing needs 25%" });
    expect(decide({ freeMemoryFraction: null, idleCores: 18 }).lend).toBe(true);
  });

  test("settings come from defaults, test timings, or are off", () => {
    expect(lendingConfig({})).toEqual(defaultLendingConfig);
    expect(defaultLendingConfig.graceMilliseconds).toBe(5_000);
    expect(lendingConfig({ LOCAL_EFFICIENCY_LENDING: "off" })).toBeNull();
    expect(lendingConfig({ LOCAL_EFFICIENCY_LENDING_GRACE_MS: "50", LOCAL_EFFICIENCY_LENDING_POLL_MS: "5" }))
      .toEqual({ ...defaultLendingConfig, graceMilliseconds: 50 });
  });

  test("the probe measures idle cores between calls", async () => {
    const probe = headroomProbe({}, 4);
    await Bun.sleep(50);
    const headroom = probe.sample();
    if (headroom === null) return;
    expect(headroom.idleCores).toBeGreaterThanOrEqual(0);
    expect(headroom.idleCores).toBeLessThanOrEqual(4);
    const memory = freeMemoryFraction();
    if (memory !== null) {
      expect(memory).toBeGreaterThanOrEqual(0);
      expect(memory).toBeLessThanOrEqual(1);
    }
    expect(headroomProbe({ LOCAL_EFFICIENCY_TEST_HEADROOM: "{\"idleCores\":7}" }, 4).sample())
      .toEqual({ freeMemoryFraction: null, idleCores: 7 });
  });
});

describe("borrowed permits in the census and telemetry", () => {
  test("status counts borrowed permits apart from the CPU pool", () => {
    const root = mkdtempSync(join(tmpdir(), "le-lending-status-"));
    try {
      const stateRoot = join(root, "host-resources-v1");
      const holders = resolveHolderRoot(stateRoot);
      const base = { admittedAt: minutesAgo(3), lane: "compute" as const, pid: process.pid, version: 1 as const };
      registerHolder(holders, { ...base, label: "soak", mode: "shared", permits: 1 }, "1111111111111111");
      registerHolder(holders, { ...base, label: "borrowed-check", mode: "heavy", permits: 2, pool: "overflow" }, "2222222222222222");
      const report = hostStatusReport({ hostParallelism: 18, now, stateRoot });
      expect(report.usedPermits).toBe(1);
      expect(report.borrowedPermits).toBe(2);
      const text = formatHostStatus(report);
      expect(text).toContain("CAPACITY\tcpu=1/6\tavailable=5\tcores=18");
      expect(text).toContain("\tborrowed=2");
      expect(text).toContain("label=borrowed-check\tpool=overflow");
      expect(text).not.toContain("label=soak\tpool");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("the census refuses an unknown pool", () => {
    const root = mkdtempSync(join(tmpdir(), "le-lending-holder-"));
    try {
      writeFileSync(join(root, `${process.pid}-3333333333333333.json`), JSON.stringify({
        admittedAt: minutesAgo(1), label: "odd", lane: "compute", mode: "shared", permits: 1,
        pid: process.pid, pool: "elsewhere", version: 1,
      }));
      expect(readHolders(root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("telemetry accepts only the overflow pool", () => {
    const event = {
      admittedAt: now.toISOString(), capacity: 6, capability: "compute", commandDigest: "a".repeat(64),
      exitCode: 0, finishedAt: now.toISOString(), label: "check", mode: "shared", outcome: "pass", permits: 1,
      program: "bun", queueMilliseconds: 1, queuedAt: now.toISOString(),
      runId: "f22bb9ba-3b6f-473a-bec0-ee7cfa7ce256", runMilliseconds: 1, scopeDigest: "b".repeat(64), version: 1,
    };
    expect(validateThroughputEvent(event)).toEqual(event);
    expect(validateThroughputEvent({ ...event, pool: "overflow" })).toEqual({ ...event, pool: "overflow" });
    expect(() => validateThroughputEvent({ ...event, pool: "main" })).toThrow("throughput event pool is invalid");
  });

  test("the overflow pool has the CPU pool's size and its own directory", () => {
    expect(overflowProfile(6)).toEqual({ id: "local-efficiency/cpu-overflow-v1-6", capacities: [{ resource: "cpu", limit: 6 }] });
    expect(resolveOverflowStateRoot("/state/host-resources-v1", 6)).toBe("/state/cpu-overflow-v1-6");
  });
});

/**
 * A scheduler stand-in. `main` is how the CPU pool behaves ("never" admits,
 * "now", or a delay in ms); `overflow` is "now" or "error". Leases are real
 * marker files, so nested host-run calls check them as they would Atet's.
 */
function fakeScheduler(root: string, behavior: { readonly main: "never" | "now" | number; readonly overflow: "now" | "error" }): {
  readonly log: string;
  readonly modulePath: string;
} {
  const modulePath = join(root, "host-resources.js");
  const log = join(root, "claims.log");
  writeFileSync(log, "");
  writeFileSync(modulePath, `
    import { createHash } from "node:crypto";
    import { appendFileSync, chmodSync, closeSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
    const behavior = ${JSON.stringify(behavior)};
    const waitingRoot = ${JSON.stringify(join(root, "state", "whole-machine-waiting-v1"))};
    const waiting = () => { try { return readdirSync(waitingRoot).length; } catch { return 0; } };
    let leases = 0;
    export function createHostResourceCoordinator(options) {
      const pool = options.profile.id.includes("overflow") ? "overflow" : options.profile.id.startsWith("local-efficiency/v1-") ? "cpu" : "lane";
      return {
        async withLease(claims, callback, leaseOptions = {}) {
          appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pool, claims, profile: options.profile, stateRoot: options.stateRoot, waiting: waiting() }) + "\\n");
          const how = pool === "overflow" ? behavior.overflow : pool === "cpu" ? behavior.main : "now";
          if (how === "error") throw Object.assign(new Error("state is unsafe"), { code: "UNSAFE_STATE" });
          if (how !== "now") {
            await new Promise((resolve, reject) => {
              const abort = () => reject(Object.assign(new Error("aborted"), { code: "WAIT_ABORTED" }));
              if (leaseOptions.signal?.aborted) return abort();
              leaseOptions.signal?.addEventListener("abort", abort, { once: true });
              if (typeof how === "number") setTimeout(resolve, how);
            });
          }
          const path = ${JSON.stringify(root)} + "/" + pool + "-" + process.pid + "-" + (leases += 1) + ".lock";
          writeFileSync(path, JSON.stringify({
            version: 1, owner: "a".repeat(32), ticket: "1", phase: "A", claims,
            profileSha256: createHash("sha256").update(JSON.stringify(options.profile)).digest("hex"),
          }), { mode: 0o600 });
          chmodSync(path, 0o600);
          const descriptor = openSync(path, "r+");
          try { return await callback({ inheritedFileDescriptor: descriptor }); }
          finally { closeSync(descriptor); unlinkSync(path); }
        },
      };
    }
  `);
  return { log, modulePath };
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(tmpdir(), "host-run-test-no-config") };
  for (const key of [
    "LOCAL_EFFICIENCY_LEASE", "LOCAL_EFFICIENCY_LENDING", "LOCAL_EFFICIENCY_TEST_HEADROOM", "CARGO_BUILD_JOBS",
    "HRA_JOBS", "MAKEFLAGS", "NEXTEST_TEST_THREADS", "RAYON_NUM_THREADS",
  ]) delete environment[key];
  return environment;
}

function hostRun(root: string, modulePath: string, flags: readonly string[], command: readonly string[], extra: NodeJS.ProcessEnv = {}) {
  return Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "host-run.ts"), ...flags, "--", ...command],
    cwd: root,
    env: {
      ...cleanEnvironment(),
      ATET_HOST_RESOURCES_MODULE: modulePath,
      LOCAL_EFFICIENCY_LENDING_GRACE_MS: "10",
      LOCAL_EFFICIENCY_LENDING_POLL_MS: "10",
      LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
      ...extra,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
}

const claimsLogged = (log: string): { pool: string; claims: { amount: number }[]; waiting: number }[] =>
  readFileSync(log, "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));

function telemetryEvents(root: string): Record<string, unknown>[] {
  const directory = join(root, "state", "telemetry-v1");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) =>
    readFileSync(join(directory, name), "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)));
}

describe("host-run borrows idle permits", () => {
  test("a run waiting on a full CPU pool borrows when the host is idle, and nested calls accept the loan", () => {
    const root = mkdtempSync(join(tmpdir(), "le-lending-borrow-"));
    try {
      const { log, modulePath } = fakeScheduler(root, { main: "never", overflow: "now" });
      const marker = join(root, "child-ran");
      const child = `
        import { readdirSync, readFileSync, writeFileSync } from "node:fs";
        const holders = ${JSON.stringify(join(root, "state", "holders-v1"))};
        const pools = readdirSync(holders).map((name) => JSON.parse(readFileSync(holders + "/" + name, "utf8")).pool);
        if (pools.length !== 1 || pools[0] !== "overflow") process.exit(30);
        writeFileSync(${JSON.stringify(marker)}, "ran");
      `;
      // The command is a nested host-run, which checks the borrowed lease it inherits.
      const nested = [process.execPath, join(import.meta.dir, "host-run.ts"), "--mode=shared", "--label=nested", "--"];
      const result = hostRun(root, modulePath, ["--mode=shared", "--label=borrower"], [...nested, process.execPath, "-e", child], {
        LOCAL_EFFICIENCY_TEST_HEADROOM: JSON.stringify({ freeMemoryFraction: 0.9, idleCores: 1_000 }),
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(result.stderr.toString()).toContain("on borrowed permits (1000.0 of");
      const entries = claimsLogged(log);
      expect(entries.map((entry) => entry.pool)).toEqual(["cpu", "overflow"]);
      expect(entries[1]?.claims).toEqual([{ amount: 1, resource: "cpu" }]);
      const events = telemetryEvents(root);
      expect(events).toHaveLength(1);
      expect(events[0]?.pool).toBe("overflow");
      expect(events[0]?.outcome).toBe("pass");
      expect(readdirSync(join(root, "state", "holders-v1"))).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a busy host, or lending turned off, keeps the run on its own permits", () => {
    for (const extra of [
      { LOCAL_EFFICIENCY_TEST_HEADROOM: JSON.stringify({ freeMemoryFraction: 0.9, idleCores: 0 }) },
      { LOCAL_EFFICIENCY_LENDING: "off", LOCAL_EFFICIENCY_TEST_HEADROOM: JSON.stringify({ idleCores: 1_000 }) },
      { LOCAL_EFFICIENCY_TEST_HEADROOM: JSON.stringify({ freeMemoryFraction: 0.05, idleCores: 1_000 }) },
    ]) {
      const root = mkdtempSync(join(tmpdir(), "le-lending-busy-"));
      try {
        const { log, modulePath } = fakeScheduler(root, { main: 300, overflow: "now" });
        const result = hostRun(root, modulePath, ["--mode=shared", "--label=waiter"], [process.execPath, "-e", "process.exit(0)"], extra);
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(claimsLogged(log).map((entry) => entry.pool)).toEqual(["cpu"]);
        expect(result.stderr.toString()).not.toContain("borrowed permits");
        expect(telemetryEvents(root)[0]?.pool).toBeUndefined();
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  });

  test("an overflow pool that cannot be used leaves the run waiting for its own permits", () => {
    const root = mkdtempSync(join(tmpdir(), "le-lending-error-"));
    try {
      const { log, modulePath } = fakeScheduler(root, { main: 300, overflow: "error" });
      const result = hostRun(root, modulePath, ["--mode=shared", "--label=fallback"], [process.execPath, "-e", "process.exit(0)"], {
        LOCAL_EFFICIENCY_TEST_HEADROOM: JSON.stringify({ idleCores: 1_000 }),
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).toContain("fallback cannot borrow permits here; waiting for its own");
      expect(claimsLogged(log).map((entry) => entry.pool)).toEqual(["cpu", "overflow"]);
      expect(telemetryEvents(root)[0]?.pool).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("an exclusive run never borrows, stops new loans while it waits, and takes every borrowed permit before it starts", () => {
    const root = mkdtempSync(join(tmpdir(), "le-lending-exclusive-"));
    try {
      const { log, modulePath } = fakeScheduler(root, { main: 200, overflow: "now" });
      const child = `
        import { readFileSync, readdirSync } from "node:fs";
        const pools = readFileSync(${JSON.stringify(join(root, "claims.log"))}, "utf8").trim().split("\\n").map((line) => JSON.parse(line).pool);
        if (readdirSync(${JSON.stringify(join(root, "state", "whole-machine-waiting-v1"))}).length !== 0) process.exit(41);
        process.exit(pools.join() === "cpu,overflow" ? 0 : 40);
      `;
      const result = hostRun(root, modulePath, ["--mode=exclusive", "--local", "--label=alone"], [process.execPath, "-e", child], {
        LOCAL_EFFICIENCY_TEST_HEADROOM: JSON.stringify({ idleCores: 1_000 }),
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const entries = claimsLogged(log);
      expect(entries.map((entry) => entry.pool)).toEqual(["cpu", "overflow"]);
      // Its record was there while it waited for the CPU pool, and is gone once it ran.
      expect(entries[0]?.waiting).toBe(1);
      expect(entries[1]?.claims).toEqual([{ amount: permitCapacity(), resource: "cpu" }]);
      expect(readdirSync(join(root, "state", "whole-machine-waiting-v1"))).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a whole-machine run still runs alone when the borrowed-permit pool cannot be used", () => {
    const root = mkdtempSync(join(tmpdir(), "le-lending-drain-error-"));
    const marker = join(root, "ran");
    try {
      const { log, modulePath } = fakeScheduler(root, { main: "now", overflow: "error" });
      const result = hostRun(root, modulePath, ["--mode=exclusive", "--local", "--label=alone"], [
        process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
      ]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).toContain("alone cannot use the borrowed-permit pool here; running on its own permits");
      expect(existsSync(marker)).toBe(true);
      expect(claimsLogged(log).map((entry) => entry.pool)).toEqual(["cpu", "overflow"]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
