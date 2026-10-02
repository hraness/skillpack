#!/usr/bin/env bun

// dev-server-reap: REPORT-ONLY census of leaked local dev servers, orphaned
// headless Chrome, and idle agent runtimes.
//
// It never signals, kills, or deletes anything. There is deliberately no
// --apply mode: acting on the report is a separate, reviewed step.
//
// Flags:
// - LISTEN processes reparented to launchd (ppid 1) whose cwd is gone, or that
//   are older than 4 h without a host-run holder or hra-port lease.
// - Headless/automation Chrome roots with ppid 1 whose target localhost port no
//   longer listens, one-shot --screenshot runs older than 10 min, or any older
//   than 2 h. Chrome using the real profile
//   (no --user-data-dir, or the default profile dir) is never listed.
// - Next.js telemetry detached-flush processes left behind by `next dev`.
// - Idle agent runtimes (Codex node_repl kernels, `codex resume`, Devin) as
//   counts only.
// It also runs `agent-browser doctor --offline --quick --json` by absolute path
// (disable with --no-doctor); doctor itself may clean stale socket/pid sidecars.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join, resolve, sep } from "node:path";

import { readHolders, resolveHolderRoot, resolveHostResourceStateRoot } from "./host-run";
import { leaseIsLive, readLeases, resolvePortStateRoot, type PortLease } from "./hra-port";

export const listenerMaximumAgeSeconds = 4 * 60 * 60;
export const chromeMaximumAgeSeconds = 2 * 60 * 60;
export const screenshotMaximumAgeSeconds = 10 * 60;

export type ProcessInfo = {
  readonly ageSeconds: number;
  readonly command: string;
  readonly pid: number;
  readonly ppid: number;
  readonly rssKilobytes: number;
};

export type Listener = { readonly pid: number; readonly ports: readonly number[]; readonly addresses: readonly string[] };

export type Snapshot = {
  readonly cwds: ReadonlyMap<number, string>;
  readonly exists: (path: string) => boolean;
  readonly holderPids: ReadonlySet<number>;
  readonly home: string;
  readonly listeners: readonly Listener[];
  readonly portLeases: readonly PortLease[];
  readonly processes: readonly ProcessInfo[];
};

export type Finding = {
  readonly ageSeconds: number;
  readonly command: string;
  readonly cwd: string | null;
  readonly kind: string;
  readonly pid: number;
  readonly ports: readonly number[];
  readonly reason: string;
  readonly rssKilobytes: number;
};

export type RuntimeSummary = {
  readonly count: number;
  readonly name: string;
  readonly oldestSeconds: number;
  readonly rssKilobytes: number;
};

export type Report = {
  readonly chrome: readonly Finding[];
  readonly flushes: readonly Finding[];
  readonly listeners: readonly Finding[];
  readonly runtimes: readonly RuntimeSummary[];
};

/** `ps` etime: [[dd-]hh:]mm:ss */
export function parseElapsed(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(value.trim());
  if (match === null) return 0;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

export function parsePs(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    processes.push({
      ageSeconds: parseElapsed(match[3] ?? ""),
      command: match[5] ?? "",
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKilobytes: Number(match[4]),
    });
  }
  return processes;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn` */
export function parseListeners(output: string): Listener[] {
  const byPid = new Map<number, { ports: Set<number>; addresses: Set<string> }>();
  let current: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      current = Number(line.slice(1));
      if (!byPid.has(current)) byPid.set(current, { addresses: new Set(), ports: new Set() });
    } else if (line.startsWith("n") && current !== null) {
      const address = line.slice(1);
      const port = Number(address.slice(address.lastIndexOf(":") + 1));
      const entry = byPid.get(current);
      if (entry !== undefined && Number.isSafeInteger(port) && port > 0) {
        entry.ports.add(port);
        entry.addresses.add(address);
      }
    }
  }
  return [...byPid.entries()].map(([pid, entry]) => ({
    addresses: [...entry.addresses].sort(),
    pid,
    ports: [...entry.ports].sort((left, right) => left - right),
  }));
}

/** `lsof -a -d cwd -Fpn -p ...` */
export function parseCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let current: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) current = Number(line.slice(1));
    else if (line.startsWith("n") && current !== null) cwds.set(current, line.slice(1));
  }
  return cwds;
}

export function listenerKind(command: string): string {
  if (/next-server|next\/dist\/bin\/next|\bnext (dev|start)\b/u.test(command)) return "next-server";
  if (/\bvite\b/u.test(command)) return "vite";
  if (/http\.server|SimpleHTTPServer/u.test(command)) return "python-http-server";
  if (/\bwrangler\b|workerd/u.test(command)) return "workerd";
  if (/\b(bun|node|deno)\b/u.test(command)) return "js-server";
  if (/\bpython[0-9.]*\b/u.test(command)) return "python";
  return "listener";
}

function ancestors(pid: number, parents: ReadonlyMap<number, number>): number[] {
  const chain: number[] = [];
  let current: number | undefined = pid;
  for (let depth = 0; depth < 32 && current !== undefined && current > 1; depth += 1) {
    chain.push(current);
    current = parents.get(current);
  }
  return chain;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function isChromeRoot(command: string): boolean {
  return /\/(Google Chrome( for Testing)?|Chromium|chrome-headless-shell|chrome)(\s|$)/u.test(command)
    && !/Helper|crashpad|--type=/u.test(command);
}

export function chromeUserDataDirectory(command: string): string | null {
  const match = /--user-data-dir=(.+?)(?= --|$)/u.exec(command);
  return match === null ? null : (match[1] ?? "").trim();
}

export function chromeTargetPorts(command: string): number[] {
  const ports = new Set<number>();
  for (const match of command.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})/gu)) {
    ports.add(Number(match[1]));
  }
  return [...ports];
}

function realProfile(directory: string | null, home: string): boolean {
  if (directory === null) return true;
  const resolved = resolve(directory);
  return [
    join(home, "Library", "Application Support", "Google", "Chrome"),
    join(home, "Library", "Application Support", "Chromium"),
    join(home, ".config", "google-chrome"),
  ].some((profile) => within(resolved, profile));
}

function finding(
  process_: ProcessInfo,
  kind: string,
  reason: string,
  cwd: string | null,
  ports: readonly number[],
): Finding {
  return {
    ageSeconds: process_.ageSeconds,
    command: process_.command.length > 240 ? `${process_.command.slice(0, 237)}...` : process_.command,
    cwd,
    kind,
    pid: process_.pid,
    ports,
    reason,
    rssKilobytes: process_.rssKilobytes,
  };
}

export function classify(snapshot: Snapshot): Report {
  const byPid = new Map(snapshot.processes.map((entry) => [entry.pid, entry]));
  const parents = new Map(snapshot.processes.map((entry) => [entry.pid, entry.ppid]));
  const listening = new Set(snapshot.listeners.flatMap((listener) => listener.ports));
  const liveLeases = snapshot.portLeases.filter((lease) => leaseIsLive(lease, new Date(), snapshot.exists));

  const listeners: Finding[] = [];
  for (const listener of snapshot.listeners) {
    const process_ = byPid.get(listener.pid);
    if (process_ === undefined || process_.ppid !== 1) continue;
    const cwd = snapshot.cwds.get(listener.pid) ?? null;
    // launchd services run from "/" and app bundles are not dev servers.
    if (
      cwd === "/"
      || (cwd !== null && /^\/(opt\/homebrew|usr\/local)\/var(\/|$)/u.test(cwd))
      || /^\/(Applications|System|Library|usr\/(s)?bin)\//u.test(process_.command)
    ) continue;
    const cwdMissing = cwd !== null && !snapshot.exists(cwd);
    const heldByHostRun = ancestors(listener.pid, parents).some((pid) => snapshot.holderPids.has(pid));
    const leased = heldByHostRun || liveLeases.some((lease) =>
      listener.ports.includes(lease.port) && cwd !== null && within(cwd, lease.worktree));
    let reason: string | null = null;
    if (cwdMissing) reason = "cwd deleted";
    else if (process_.ageSeconds > listenerMaximumAgeSeconds && !leased) {
      reason = "older than 4h without a host-run holder or hra-port lease";
    }
    if (reason !== null) {
      listeners.push(finding(process_, listenerKind(process_.command), reason, cwd, listener.ports));
    }
  }

  const chrome: Finding[] = [];
  for (const process_ of snapshot.processes) {
    if (process_.ppid !== 1 || !isChromeRoot(process_.command)) continue;
    const profile = chromeUserDataDirectory(process_.command);
    if (realProfile(profile, snapshot.home)) continue;
    const automated = /--headless|--remote-debugging-(port|pipe)|--screenshot/u.test(process_.command)
      || /\/(private\/)?(tmp|var\/folders)\/|\.agent-browser|agent-browser-chrome/u.test(profile ?? "");
    if (!automated) continue;
    const targets = chromeTargetPorts(process_.command);
    const dead = targets.filter((port) => !listening.has(port));
    let reason: string | null = null;
    if (dead.length > 0) reason = `target port ${dead.join(",")} not listening`;
    else if (/--screenshot/u.test(process_.command) && process_.ageSeconds > screenshotMaximumAgeSeconds) {
      reason = "one-shot --screenshot still running after 10m";
    } else if (process_.ageSeconds > chromeMaximumAgeSeconds) reason = "older than 2h";
    if (reason !== null) chrome.push(finding(process_, "headless-chrome", reason, profile, targets));
  }

  const flushes = snapshot.processes
    .filter((entry) => entry.ppid === 1 && /next\/dist\/telemetry\/detached-flush\.js/u.test(entry.command))
    .map((entry) => finding(entry, "next-telemetry-flush", "detached-flush never exited", snapshot.cwds.get(entry.pid) ?? null, []));

  const runtimePatterns: readonly [string, RegExp][] = [
    ["codex node_repl", /\/node_repl(\s|$)/u],
    ["codex resume", /\bcodex\b.*\bresume\b/u],
    ["devin", /(^|\/)devin(\s|$)(?!.*\bacp\b)/u],
    ["devin acp", /(^|\/)devin\s+acp\b/u],
  ];
  const runtimes: RuntimeSummary[] = [];
  for (const [name, pattern] of runtimePatterns) {
    const matched = snapshot.processes.filter((entry) => pattern.test(entry.command));
    if (matched.length === 0) continue;
    runtimes.push({
      count: matched.length,
      name,
      oldestSeconds: Math.max(...matched.map((entry) => entry.ageSeconds)),
      rssKilobytes: matched.reduce((sum, entry) => sum + entry.rssKilobytes, 0),
    });
  }
  const byAge = (left: Finding, right: Finding): number => right.ageSeconds - left.ageSeconds;
  return {
    chrome: chrome.sort(byAge),
    flushes: flushes.sort(byAge),
    listeners: listeners.sort(byAge),
    runtimes,
  };
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

export function collectSnapshot(environment: Readonly<NodeJS.ProcessEnv> = process.env): Snapshot {
  const processes = parsePs(run("ps", ["-ww", "-axo", "pid=,ppid=,etime=,rss=,command="]));
  const listeners = parseListeners(run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
  const interesting = [
    ...listeners.map((listener) => listener.pid),
    ...processes.filter((entry) => entry.ppid === 1 && /detached-flush/u.test(entry.command)).map((entry) => entry.pid),
  ];
  const cwds = interesting.length === 0
    ? new Map<number, string>()
    : parseCwds(run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", [...new Set(interesting)].join(",")]));
  let holderPids = new Set<number>();
  try {
    holderPids = new Set(readHolders(resolveHolderRoot(resolveHostResourceStateRoot(environment)))
      .map((holder) => holder.pid));
  } catch {
    // no holder state
  }
  let portLeases: PortLease[] = [];
  try {
    portLeases = readLeases(resolvePortStateRoot(environment));
  } catch {
    // no port state
  }
  return { cwds, exists: existsSync, holderPids, home: homedir(), listeners, portLeases, processes };
}

/** agent-browser is not on PATH here; resolve its native binary by absolute path. */
export function agentBrowserBinary(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  home = homedir(),
): string | null {
  const configured = environment.AGENT_BROWSER_BIN;
  const candidates = [
    ...(configured === undefined || configured === "" ? [] : [configured]),
    join(home, ".bun", "install", "global", "node_modules", "agent-browser", "bin", `agent-browser-${platform()}-${arch()}`),
    join(home, ".bun", "bin", "agent-browser"),
    "/opt/homebrew/bin/agent-browser",
    "/usr/local/bin/agent-browser",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function agentBrowserDoctor(binary: string | null): { readonly binary: string | null; readonly summary: string } {
  if (binary === null) return { binary, summary: "agent-browser not installed" };
  const result = spawnSync(binary, ["doctor", "--offline", "--quick", "--json"], {
    encoding: "utf8",
    env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? "60000" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  const text = `${result.stdout ?? ""}`.trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const checks = Array.isArray(parsed.checks) ? parsed.checks as Record<string, unknown>[] : [];
    const counts = new Map<string, number>();
    for (const check of checks) {
      const status = String(check.status ?? check.result ?? "unknown");
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([status, count]) => `${status}=${count}`);
    return { binary, summary: parts.length > 0 ? parts.join(" ") : `exit ${result.status ?? "?"}` };
  } catch {
    return { binary, summary: `exit ${result.status ?? "?"}${text === "" ? "" : `: ${text.split("\n")[0]}`}` };
  }
}

function age(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}

function megabytes(kilobytes: number): string {
  return `${Math.round(kilobytes / 1024)}MB`;
}

export function formatReport(report: Report, doctor: { readonly binary: string | null; readonly summary: string } | null): string {
  const lines: string[] = ["dev-server-reap (report only; nothing was signalled or removed)"];
  const section = (title: string, findings: readonly Finding[]): void => {
    const rss = findings.reduce((sum, entry) => sum + entry.rssKilobytes, 0);
    lines.push("", `${title}: ${findings.length}${findings.length > 0 ? ` (${megabytes(rss)} RSS)` : ""}`);
    for (const entry of findings) {
      lines.push(
        `  pid ${entry.pid}\t${entry.kind}\tage ${age(entry.ageSeconds)}\t${megabytes(entry.rssKilobytes)}`
        + `${entry.ports.length > 0 ? `\tports ${entry.ports.join(",")}` : ""}\t${entry.reason}`,
      );
      if (entry.cwd !== null) lines.push(`    ${entry.kind === "headless-chrome" ? "profile" : "cwd"} ${entry.cwd}`);
    }
  };
  section("Orphan listeners (ppid 1)", report.listeners);
  section("Orphan headless Chrome (ppid 1)", report.chrome);
  section("Next telemetry detached-flush leftovers", report.flushes);
  lines.push("", "Agent runtimes (report only):");
  if (report.runtimes.length === 0) lines.push("  none");
  for (const runtime of report.runtimes) {
    lines.push(`  ${runtime.name}\tcount ${runtime.count}\t${megabytes(runtime.rssKilobytes)}\toldest ${age(runtime.oldestSeconds)}`);
  }
  if (doctor !== null) lines.push("", `agent-browser doctor (${doctor.binary ?? "missing"}): ${doctor.summary}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const unknown = arguments_.filter((argument) => !["--json", "--no-doctor"].includes(argument));
  if (unknown.length > 0) {
    console.error(`[dev-server-reap] unknown argument: ${unknown[0]} (report only; there is no --apply)`);
    console.error("Usage: dev-server-reap [--json] [--no-doctor]");
    process.exitCode = 2;
  } else {
    const report = classify(collectSnapshot());
    const doctor = arguments_.includes("--no-doctor") ? null : agentBrowserDoctor(agentBrowserBinary());
    if (arguments_.includes("--json")) console.log(JSON.stringify({ ...report, doctor }, null, 2));
    else console.log(formatReport(report, doctor));
  }
}
