/**
 * Idle-permit lending.
 *
 * A CPU permit stands for cores/capacity cores, but a holder can sit nearly
 * idle for hours: a soak, an emulator, a dev loop. While the CPU pool is full,
 * a waiting shared or heavy run may borrow permits from a second pool of the
 * same size, but only when this host measurably has the cores and memory for
 * it. Exclusive runs never borrow. A run that takes the whole CPU pool also
 * takes the whole borrowed pool, so it still runs alone.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";

import type { HolderRecord } from "./host-run";

export type LendingConfig = {
  /** How long a run waits for an ordinary permit before it may borrow one. */
  readonly graceMilliseconds: number;
  /** How often a waiting run measures this host again. */
  readonly pollMilliseconds: number;
  /** Share of the cores that stays idle after a loan. */
  readonly reserveCoreFraction: number;
  /** Least share of memory the kernel can still hand out without paging. */
  readonly minimumFreeMemoryFraction: number;
  /** A new borrower counts at its full share this long, until the measurement catches up with it. */
  readonly rampMilliseconds: number;
};

export const defaultLendingConfig: LendingConfig = Object.freeze({
  // Long, nearly idle holders can keep the pool full for hours, so every waiting run pays
  // this wait. The ramp and the core reserve, not the wait, keep loans in check.
  graceMilliseconds: 5_000,
  minimumFreeMemoryFraction: 0.25,
  pollMilliseconds: 15_000,
  rampMilliseconds: 90_000,
  reserveCoreFraction: 0.2,
});

export type Headroom = {
  /** Cores idle over the last measurement window. */
  readonly idleCores: number;
  /** Share of memory available without paging; null when this platform cannot say. */
  readonly freeMemoryFraction: number | null;
};

export type LendingHolder = Pick<HolderRecord, "admittedAt" | "permits" | "pool">;

export type LendingDecision = { readonly lend: boolean; readonly reason: string };

function milliseconds(environment: Readonly<NodeJS.ProcessEnv>, name: string, fallback: number): number {
  const value = Number(environment[name]);
  return Number.isFinite(value) && value >= 10 ? value : fallback;
}

/** The lending settings, or null when `LOCAL_EFFICIENCY_LENDING=off`. */
export function lendingConfig(environment: Readonly<NodeJS.ProcessEnv>): LendingConfig | null {
  if (environment.LOCAL_EFFICIENCY_LENDING === "off") return null;
  return {
    ...defaultLendingConfig,
    graceMilliseconds: milliseconds(
      environment,
      "LOCAL_EFFICIENCY_LENDING_GRACE_MS",
      defaultLendingConfig.graceMilliseconds,
    ),
    pollMilliseconds: milliseconds(
      environment,
      "LOCAL_EFFICIENCY_LENDING_POLL_MS",
      defaultLendingConfig.pollMilliseconds,
    ),
  };
}

/** Whether a run asking for `permits` may borrow them now. Pure: every input is passed in. */
export function lendingDecision(input: {
  readonly capacity: number;
  readonly config: LendingConfig;
  readonly headroom: Headroom;
  readonly holders: readonly LendingHolder[];
  readonly hostParallelism: number;
  readonly now: Date;
  readonly permits: number;
  /** Live runs that need every permit and are still waiting for them. */
  readonly waiting?: readonly LendingHolder[];
}): LendingDecision {
  const { capacity, config, headroom, holders, hostParallelism, now, permits } = input;
  if (permits >= capacity) return { lend: false, reason: "a whole-machine run never borrows" };
  if (holders.some((holder) => holder.permits >= capacity)) {
    return { lend: false, reason: "a whole-machine run holds this host" };
  }
  if ((input.waiting ?? []).length > 0) {
    return { lend: false, reason: "a whole-machine run is waiting for this host" };
  }
  const coresPerPermit = hostParallelism / Math.max(1, capacity);
  const ramping = holders
    .filter((holder) => {
      if (holder.pool !== "overflow") return false;
      const age = now.getTime() - Date.parse(holder.admittedAt);
      return !(age >= config.rampMilliseconds);
    })
    .reduce((sum, holder) => sum + holder.permits * coresPerPermit, 0);
  const needed = permits * coresPerPermit + ramping + config.reserveCoreFraction * hostParallelism;
  const idle = `${headroom.idleCores.toFixed(1)} of ${hostParallelism} cores idle`;
  if (headroom.idleCores < needed) {
    return { lend: false, reason: `${idle}; borrowing needs ${needed.toFixed(1)}` };
  }
  if (
    headroom.freeMemoryFraction !== null
    && headroom.freeMemoryFraction < config.minimumFreeMemoryFraction
  ) {
    const free = Math.round(headroom.freeMemoryFraction * 100);
    const least = Math.round(config.minimumFreeMemoryFraction * 100);
    return { lend: false, reason: `${free}% of memory free; borrowing needs ${least}%` };
  }
  return { lend: true, reason: idle };
}

type CpuSample = { readonly cores: number; readonly idle: number; readonly total: number };

function sampleCpu(): CpuSample | null {
  try {
    const list = cpus();
    if (list.length === 0) return null;
    let idle = 0;
    let total = 0;
    for (const { times } of list) {
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { cores: list.length, idle, total };
  } catch {
    return null;
  }
}

/** Share of memory available without paging, from the kernel's own figure. */
export function freeMemoryFraction(platform: NodeJS.Platform = process.platform): number | null {
  if (platform === "darwin") {
    try {
      const result = spawnSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level"], {
        encoding: "utf8",
        timeout: 2_000,
      });
      const value = Number(result.stdout.trim());
      return result.status === 0 && Number.isFinite(value) && value >= 0 && value <= 100
        ? value / 100
        : null;
    } catch {
      return null;
    }
  }
  if (platform === "linux") {
    try {
      const text = readFileSync("/proc/meminfo", "utf8");
      const field = (name: string): number | null => {
        const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "mu").exec(text);
        return match === null ? null : Number(match[1]);
      };
      const total = field("MemTotal");
      const available = field("MemAvailable");
      return total === null || available === null || total <= 0 ? null : available / total;
    } catch {
      return null;
    }
  }
  return null;
}

export type HeadroomProbe = {
  /** Idle cores since the previous call (the first call starts the window and returns null), and free memory. */
  readonly sample: () => Headroom | null;
};

/**
 * Measures this host between calls. `LOCAL_EFFICIENCY_TEST_HEADROOM` (JSON
 * `{"idleCores": n, "freeMemoryFraction": f}`) replaces the measurement, for
 * tests only.
 */
export function headroomProbe(
  environment: Readonly<NodeJS.ProcessEnv>,
  hostParallelism: number,
): HeadroomProbe {
  const fixed = environment.LOCAL_EFFICIENCY_TEST_HEADROOM;
  if (fixed !== undefined && fixed !== "") {
    return {
      sample: () => {
        try {
          const parsed = JSON.parse(fixed) as Partial<Headroom>;
          return typeof parsed.idleCores === "number"
            ? { freeMemoryFraction: parsed.freeMemoryFraction ?? null, idleCores: parsed.idleCores }
            : null;
        } catch {
          return null;
        }
      },
    };
  }
  let previous = sampleCpu();
  return {
    sample: () => {
      const current = sampleCpu();
      const earlier = previous;
      previous = current;
      if (current === null || earlier === null || current.cores !== earlier.cores) return null;
      const total = current.total - earlier.total;
      const idle = current.idle - earlier.idle;
      if (!(total > 0) || idle < 0) return null;
      const idleCores = Math.min(1, idle / total) * Math.min(current.cores, hostParallelism);
      return { freeMemoryFraction: freeMemoryFraction(), idleCores };
    },
  };
}
