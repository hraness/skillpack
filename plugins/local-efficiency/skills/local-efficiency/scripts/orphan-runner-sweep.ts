#!/usr/bin/env bun

// orphan-runner-sweep: finds JavaScript test runners left behind by finished
// agent tasks and, only with --apply, asks them to stop with SIGTERM.
//
// A candidate is a process that:
// - belongs to the current user,
// - has been reparented to init/launchd (ppid 1),
// - is a node/bun/deno test runner (`node --test`, its `--test-*` children,
//   `*.test.*`/`*.spec.*` scripts, `bun test`, vitest or jest workers),
// - is older than --min-age (default 2h),
// - is not inside a live host-run lease (holders-v1 census) and its process
//   group is not still attached to a live process tree or an agent runtime.
//
// The default is a dry run. --apply re-verifies each candidate's start token
// (PID reuse safety), command, and parent immediately before SIGTERM, waits
// for --grace (default 10s), and reports survivors. It never sends SIGKILL or
// any other signal; survivors are left for the operator.

import { spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";

import { parseElapsed } from "./dev-server-reap";
import {
  parseDuration,
  processStartIdentity,
  readHolders,
  resolveHolderRoot,
  resolveHostResourceStateRoot,
  type ProcessStartIdentity,
} from "./host-run";

export const defaultMinimumAgeSeconds = 2 * 60 * 60;
export const defaultGraceMilliseconds = 10_000;

export type RunnerProcess = {
  readonly ageSeconds: number;
  readonly command: string;
  readonly cpuPercent: number;
  readonly cpuTime: string;
  readonly pgid: number;
  readonly pid: number;
  readonly ppid: number;
  readonly rssKilobytes: number;
  readonly uid: number;
};

export type SweepSnapshot = {
  readonly cwds: ReadonlyMap<number, string>;
  readonly holderPids: ReadonlySet<number>;
  readonly processes: readonly RunnerProcess[];
  readonly selfPid: number;
  readonly uid: number;
};

export type Candidate = {
  readonly ageSeconds: number;
  readonly command: string;
  readonly cpuPercent: number;
  readonly cpuTime: string;
  readonly cwd: string | null;
  readonly kind: string;
  readonly pgid: number;
  readonly pid: number;
  readonly rssKilobytes: number;
};

export type Skipped = {
  readonly kind: string;
  readonly pid: number;
  readonly reason: string;
};

export type Selection = {
  readonly candidates: readonly Candidate[];
  readonly skipped: readonly Skipped[];
};

/** `ps -axo pid=,ppid=,pgid=,uid=,etime=,%cpu=,rss=,time=,command=` */
export function parseRunnerPs(output: string): RunnerProcess[] {
  const processes: RunnerProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([0-9.,]+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    processes.push({
      ageSeconds: parseElapsed(match[5] ?? ""),
      command: match[9] ?? "",
      cpuPercent: Number((match[6] ?? "0").replace(",", ".")),
      cpuTime: match[8] ?? "",
      pgid: Number(match[3]),
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKilobytes: Number(match[7]),
      uid: Number(match[4]),
    });
  }
  return processes;
}

const jsRuntime = /^(node|nodejs|bun|deno)(\d+(\.\d+)*)?$/u;
const agentRuntime = /(^|\/)(claude|codex|devin|agy)(\s|$)/u;

function basename(token: string): string {
  return token.slice(token.lastIndexOf("/") + 1);
}

/** Returns the runner kind, or null when the command is not a JS test runner. */
export function testRunnerKind(command: string): string | null {
  const tokens = command.trim().split(/\s+/u);
  const runtime = basename(tokens[0] ?? "");
  if (!jsRuntime.test(runtime)) return null;
  if (/xctest|xcodebuild/iu.test(command)) return null;
  const arguments_ = tokens.slice(1);
  if (/node_modules\/(vitest|tinypool)\/|(^|\/)vitest(\.m?js)?$/u.test(arguments_.join(" "))
    || arguments_.some((argument) => /(^|\/)vitest(\.m?[jt]s)?$/u.test(argument))) return "vitest";
  if (/node_modules\/(jest|jest-cli|jest-worker|@jest\/[^/\s]+)\//u.test(arguments_.join(" "))
    || arguments_.some((argument) => /(^|\/)jest(\.js)?$/u.test(argument))) return "jest";
  if (runtime.startsWith("bun") && arguments_.find((argument) => !argument.startsWith("-")) === "test") return "bun-test";
  if (runtime.startsWith("deno") && arguments_[0] === "test") return "deno-test";
  if (arguments_.some((argument) => argument === "--test" || argument.startsWith("--test-") || argument.startsWith("--test="))) {
    return "node-test";
  }
  if (arguments_.some((argument) => /\.(test|spec)\.[cm]?[jt]sx?$/u.test(argument))) return "test-file";
  return null;
}

function ancestors(pid: number, parents: ReadonlyMap<number, number>): number[] {
  const chain: number[] = [];
  let current: number | undefined = pid;
  for (let depth = 0; depth < 64 && current !== undefined && current > 1; depth += 1) {
    chain.push(current);
    current = parents.get(current);
  }
  return chain;
}

/**
 * Why a test runner must be left alone, or null when it is an orphan. Checks the
 * process and every other member of its process group: a group that still has a
 * live leader, a member attached to a live parent, a host-run holder, or an
 * agent runtime in any member's ancestry belongs to work that is still running.
 */
export function protection(
  process_: RunnerProcess,
  snapshot: SweepSnapshot,
  byPid: ReadonlyMap<number, RunnerProcess>,
  parents: ReadonlyMap<number, number>,
): string | null {
  if (process_.pid === snapshot.selfPid) return "this sweep";
  if (ancestors(snapshot.selfPid, parents).includes(process_.pid)) return "ancestor of this sweep";
  const group = snapshot.processes.filter((entry) => entry.pgid === process_.pgid && entry.pid !== process_.pid);
  const leader = byPid.get(process_.pgid);
  if (process_.pgid !== process_.pid && leader !== undefined) return `process group leader ${leader.pid} is alive`;
  const attached = group.find((entry) => entry.ppid !== 1);
  if (attached !== undefined) return `process group member ${attached.pid} still has a live parent`;
  for (const member of [process_, ...group]) {
    for (const pid of ancestors(member.pid, parents)) {
      if (snapshot.holderPids.has(pid)) return `inside live host-run lease (holder pid ${pid})`;
      const command = byPid.get(pid)?.command ?? "";
      if (pid !== member.pid && agentRuntime.test(command)) return `descendant of live agent session ${pid}`;
    }
  }
  if (snapshot.holderPids.has(process_.pgid)) return `inside live host-run lease (holder pid ${process_.pgid})`;
  return null;
}

export function selectCandidates(snapshot: SweepSnapshot, minimumAgeSeconds = defaultMinimumAgeSeconds): Selection {
  const byPid = new Map(snapshot.processes.map((entry) => [entry.pid, entry]));
  const parents = new Map(snapshot.processes.map((entry) => [entry.pid, entry.ppid]));
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  for (const process_ of snapshot.processes) {
    if (process_.uid !== snapshot.uid || process_.ppid !== 1 || process_.pid <= 1) continue;
    const kind = testRunnerKind(process_.command);
    if (kind === null) continue;
    if (process_.ageSeconds < minimumAgeSeconds) {
      skipped.push({ kind, pid: process_.pid, reason: "younger than the age threshold" });
      continue;
    }
    const reason = protection(process_, snapshot, byPid, parents);
    if (reason !== null) {
      skipped.push({ kind, pid: process_.pid, reason });
      continue;
    }
    candidates.push({
      ageSeconds: process_.ageSeconds,
      command: process_.command,
      cpuPercent: process_.cpuPercent,
      cpuTime: process_.cpuTime,
      cwd: snapshot.cwds.get(process_.pid) ?? null,
      kind,
      pgid: process_.pgid,
      pid: process_.pid,
      rssKilobytes: process_.rssKilobytes,
    });
  }
  candidates.sort((left, right) => right.ageSeconds - left.ageSeconds);
  return { candidates, skipped };
}

export type Outcome = {
  readonly pid: number;
  readonly result: "stopped" | "survived" | "skipped";
  readonly detail: string;
};

/** Everything --apply touches, injectable so tests never signal real processes. */
export type SweepEffects = {
  /** Fresh ppid and command for a pid, or null when it is gone. */
  readonly describe: (pid: number) => { readonly ppid: number; readonly command: string } | null;
  readonly identity: (pid: number) => ProcessStartIdentity | null;
  readonly now: () => number;
  /** Only ever called with SIGTERM. */
  readonly signal: (pid: number, signal: "SIGTERM") => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
};

export const survivorHint = "ignored SIGTERM; this sweep never sends SIGKILL. Inspect it (ps -o pid,stat,wchan,command -p PID; "
  + "sample PID on macOS), and stop it yourself only after confirming no task owns it.";

function sameProcess(
  pid: number,
  token: string,
  command: string,
  effects: SweepEffects,
): boolean {
  const current = effects.identity(pid);
  if (current === null || current.token !== token) return false;
  const description = effects.describe(pid);
  return description !== null && description.ppid === 1 && description.command === command;
}

/**
 * Sends SIGTERM to each candidate whose start token, parent, and command are
 * unchanged, waits up to graceMilliseconds, and reports which ones are still
 * running. Survivors are reported, never escalated.
 */
export async function applySweep(
  candidates: readonly Candidate[],
  effects: SweepEffects,
  graceMilliseconds = defaultGraceMilliseconds,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const signalled: { readonly pid: number; readonly token: string; readonly command: string }[] = [];
  for (const candidate of candidates) {
    const identity = effects.identity(candidate.pid);
    if (identity === null) {
      outcomes.push({ detail: "start identity unavailable; not signalled", pid: candidate.pid, result: "skipped" });
      continue;
    }
    if (!sameProcess(candidate.pid, identity.token, candidate.command, effects)) {
      outcomes.push({ detail: "process changed or exited before signalling", pid: candidate.pid, result: "skipped" });
      continue;
    }
    try {
      effects.signal(candidate.pid, "SIGTERM");
      signalled.push({ command: candidate.command, pid: candidate.pid, token: identity.token });
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "error";
      outcomes.push({
        detail: code === "ESRCH" ? "exited before SIGTERM" : `SIGTERM failed (${code})`,
        pid: candidate.pid,
        result: code === "ESRCH" ? "stopped" : "skipped",
      });
    }
  }
  const deadline = effects.now() + graceMilliseconds;
  let pending = signalled;
  while (pending.length > 0) {
    pending = pending.filter((entry) => sameProcess(entry.pid, entry.token, entry.command, effects));
    if (pending.length === 0 || effects.now() >= deadline) break;
    await effects.sleep(Math.min(250, Math.max(1, deadline - effects.now())));
  }
  const survivors = new Set(pending.map((entry) => entry.pid));
  for (const entry of signalled) {
    outcomes.push(survivors.has(entry.pid)
      ? { detail: survivorHint.replaceAll("PID", String(entry.pid)), pid: entry.pid, result: "survived" }
      : { detail: "exited after SIGTERM", pid: entry.pid, result: "stopped" });
  }
  return outcomes;
}

function run(command: string, arguments_: readonly string[], timeout = 30_000): string {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
  });
  return result.stdout ?? "";
}

const psColumns = "pid=,ppid=,pgid=,uid=,etime=,%cpu=,rss=,time=,command=";

function readCwds(pids: readonly number[]): Map<number, string> {
  const cwds = new Map<number, string>();
  if (pids.length === 0) return cwds;
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        cwds.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // gone or not readable
      }
    }
    return cwds;
  }
  let current: number | null = null;
  for (const line of run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]).split("\n")) {
    if (line.startsWith("p")) current = Number(line.slice(1));
    else if (line.startsWith("n") && current !== null) cwds.set(current, line.slice(1));
  }
  return cwds;
}

export function collectSweepSnapshot(environment: Readonly<NodeJS.ProcessEnv> = process.env): SweepSnapshot {
  const processes = parseRunnerPs(run("ps", ["-ww", "-axo", psColumns]));
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  let holderPids = new Set<number>();
  try {
    holderPids = new Set(readHolders(resolveHolderRoot(resolveHostResourceStateRoot(environment))).map((holder) => holder.pid));
  } catch {
    // no holder state
  }
  const interesting = processes
    .filter((entry) => entry.uid === uid && entry.ppid === 1 && testRunnerKind(entry.command) !== null)
    .map((entry) => entry.pid);
  return { cwds: readCwds(interesting), holderPids, processes, selfPid: process.pid, uid };
}

export function systemEffects(): SweepEffects {
  return {
    describe(pid) {
      const [row] = parseRunnerPs(run("ps", ["-ww", "-o", psColumns, "-p", String(pid)]));
      return row === undefined || row.pid !== pid ? null : { command: row.command, ppid: row.ppid };
    },
    identity: processStartIdentity,
    now: () => Date.now(),
    signal(pid, signal) {
      if (signal !== "SIGTERM") throw new Error("orphan-runner-sweep only sends SIGTERM");
      process.kill(pid, signal);
    },
    sleep: (milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds)),
  };
}

function age(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}

function shortCommand(command: string): string {
  // Keep the head (runtime) and the tail (usually the test file).
  return command.length > 200 ? `${command.slice(0, 80)} ... ${command.slice(-115)}` : command;
}

export function formatSelection(selection: Selection, minimumAgeSeconds: number, apply: boolean): string {
  const lines = [
    apply
      ? `orphan-runner-sweep --apply (SIGTERM only; min age ${age(minimumAgeSeconds)})`
      : `orphan-runner-sweep (dry run; nothing was signalled; min age ${age(minimumAgeSeconds)})`,
    "",
    `Orphaned test runners (ppid 1): ${selection.candidates.length}`,
  ];
  for (const entry of selection.candidates) {
    lines.push(
      `  pid ${entry.pid}\t${entry.kind}\tage ${age(entry.ageSeconds)}\tcpu ${entry.cpuPercent}% (${entry.cpuTime})`
      + `\t${Math.round(entry.rssKilobytes / 1024)}MB`,
      `    cwd ${entry.cwd ?? "?"}`,
      `    ${shortCommand(entry.command)}`,
    );
  }
  if (selection.skipped.length > 0) {
    lines.push("", `Left alone: ${selection.skipped.length}`);
    for (const entry of selection.skipped) lines.push(`  pid ${entry.pid}\t${entry.kind}\t${entry.reason}`);
  }
  if (!apply && selection.candidates.length > 0) lines.push("", "Run with --apply to send SIGTERM to the listed processes.");
  return lines.join("\n");
}

export function formatOutcomes(outcomes: readonly Outcome[]): string {
  if (outcomes.length === 0) return "";
  return ["", "Results:", ...outcomes.map((entry) => `  pid ${entry.pid}\t${entry.result}\t${entry.detail}`)].join("\n");
}

export type SweepOptions = {
  readonly apply: boolean;
  readonly graceMilliseconds: number;
  readonly json: boolean;
  readonly minimumAgeSeconds: number;
};

export const usage = "Usage: orphan-runner-sweep [--apply] [--min-age=DURATION] [--grace=DURATION] [--json]\n"
  + "  Lists orphaned node/bun test runners (dry run). --apply sends SIGTERM only, never SIGKILL.\n"
  + "  DURATION: 90s, 20m, 1.5h (default min age 2h, grace 10s).";

export function parseSweepArguments(arguments_: readonly string[]): SweepOptions | { readonly error: string } | "help" {
  let apply = false;
  let json = false;
  let minimumAgeSeconds = defaultMinimumAgeSeconds;
  let graceMilliseconds = defaultGraceMilliseconds;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    const [flag, inline] = argument.includes("=") ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)] : [argument, undefined];
    const value = (): string | undefined => inline ?? arguments_[++index];
    try {
      if (flag === "--help" || flag === "-h") return "help";
      else if (flag === "--apply") apply = true;
      else if (flag === "--json") json = true;
      else if (flag === "--min-age") {
        const parsed = parseDuration(value() ?? "");
        if (parsed === null) return { error: "--min-age needs a duration" };
        minimumAgeSeconds = Math.round(parsed / 1_000);
      } else if (flag === "--grace") {
        const parsed = parseDuration(value() ?? "");
        if (parsed === null) return { error: "--grace needs a duration" };
        graceMilliseconds = parsed;
      } else return { error: `unknown argument: ${argument}` };
    } catch (error: unknown) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { apply, graceMilliseconds, json, minimumAgeSeconds };
}

if (import.meta.main) {
  const options = parseSweepArguments(process.argv.slice(2));
  if (options === "help") {
    console.log(usage);
  } else if ("error" in options) {
    console.error(`[orphan-runner-sweep] ${options.error}`);
    console.error(usage);
    process.exitCode = 2;
  } else if (process.platform !== "darwin" && process.platform !== "linux") {
    console.error(`[orphan-runner-sweep] unsupported platform: ${process.platform}`);
    process.exitCode = 2;
  } else {
    const selection = selectCandidates(collectSweepSnapshot(), options.minimumAgeSeconds);
    const outcomes = options.apply ? await applySweep(selection.candidates, systemEffects(), options.graceMilliseconds) : [];
    if (options.json) console.log(JSON.stringify({ ...selection, apply: options.apply, outcomes }, null, 2));
    else console.log(formatSelection(selection, options.minimumAgeSeconds, options.apply) + formatOutcomes(outcomes));
    if (outcomes.some((entry) => entry.result === "survived")) process.exitCode = 1;
  }
}
