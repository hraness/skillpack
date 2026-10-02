#!/usr/bin/env bun

// hra-disk-guard: warn-only disk headroom checks and REPORT-ONLY janitor.
//
//   hra-disk-guard check [--hook] [--warn-gib=60]
//       Warn when the home volume has less than 60 GiB free. Always exits 0.
//       --hook prints a Claude Code hook JSON systemMessage instead of stderr,
//       so it can be registered as a PreToolUse hook (not registered here).
//   hra-disk-guard report [--force] [--top=10]
//       Top scratchpad and worktree directories by size, at most once a day
//       unless --force. Saved under ~/.local/state/local-efficiency/disk-v1/.
//   hra-disk-guard janitor --report [--json] [--no-sizes]
//       Lists what an hourly janitor would reclaim: Chrome code_sign_clone
//       copies older than 12 h that no process holds, and bun $TMPDIR staging
//       directories older than 60 min while no `bun install|add` runs.
//   hra-disk-guard scheduled
//       check + janitor --report + daily report, appending one summary line to
//       the disk-v1 log. This is what the launchd template runs hourly.
//
// Nothing here deletes files: the janitor has no deletion mode.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const gibibyte = 1024 ** 3;
export const warnFreeGibibytes = 60;
export const cloneMinimumAgeMilliseconds = 12 * 60 * 60_000;
export const bunStagingMinimumAgeMilliseconds = 60 * 60_000;
export const reportIntervalMilliseconds = 24 * 60 * 60_000;
export const bunStagingName = /^\.[0-9a-f]{16}-[0-9A-F]{8}\..+$/u;
export const cloneName = /^code_sign_clone\.[A-Za-z0-9]+$/u;

export function resolveDiskStateRoot(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.LOCAL_EFFICIENCY_DISK_ROOT;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) throw new Error("LOCAL_EFFICIENCY_DISK_ROOT must be absolute");
    return resolve(configured);
  }
  const xdgState = environment.XDG_STATE_HOME;
  if (xdgState !== undefined && xdgState !== "") {
    if (!isAbsolute(xdgState)) throw new Error("XDG_STATE_HOME must be absolute");
    return join(resolve(xdgState), "local-efficiency", "disk-v1");
  }
  return join(resolve(userHome), ".local", "state", "local-efficiency", "disk-v1");
}

export function freeBytes(path = homedir()): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function formatBytes(bytes: number): string {
  if (bytes >= gibibyte) return `${(bytes / gibibyte).toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/** A warning line when free space is under the threshold, else null. */
export function headroomWarning(free: number, warnGibibytes = warnFreeGibibytes): string | null {
  if (free >= warnGibibytes * gibibyte) return null;
  return `Low disk: ${formatBytes(free)} free (< ${warnGibibytes} GiB). Avoid large clones, builds and`
    + " browser runs; see `hra-disk-guard janitor --report` for reclaimable space.";
}

/** Claude Code hook output: a warning only, never a permission decision. */
export function hookOutput(warning: string | null): string {
  return warning === null ? "" : JSON.stringify({ systemMessage: warning });
}

export type Candidate = {
  readonly ageMilliseconds: number;
  readonly eligible: boolean;
  readonly name: string;
  readonly path: string;
  readonly reason: string;
  readonly sizeKilobytes: number | null;
};

export type Entry = { readonly modifiedAt: number; readonly name: string };

export function listEntries(directory: string, pattern: RegExp): Entry[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try {
      const metadata = statSync(join(directory, name));
      if (metadata.isDirectory()) entries.push({ modifiedAt: metadata.mtimeMs, name });
    } catch {
      // raced with removal
    }
  }
  return entries;
}

export function classifyClones(
  directory: string,
  entries: readonly Entry[],
  held: ReadonlySet<string>,
  now: number,
): Candidate[] {
  return entries.map((entry) => {
    const ageMilliseconds = Math.max(0, now - entry.modifiedAt);
    const isHeld = held.has(entry.name);
    const young = ageMilliseconds < cloneMinimumAgeMilliseconds;
    return {
      ageMilliseconds,
      eligible: !isHeld && !young,
      name: entry.name,
      path: join(directory, entry.name),
      reason: isHeld ? "held open" : young ? "younger than 12h" : "older than 12h, not held",
      sizeKilobytes: null,
    };
  });
}

export function classifyBunStaging(
  directory: string,
  entries: readonly Entry[],
  installActive: boolean,
  now: number,
): Candidate[] {
  return entries.map((entry) => {
    const ageMilliseconds = Math.max(0, now - entry.modifiedAt);
    const young = ageMilliseconds < bunStagingMinimumAgeMilliseconds;
    return {
      ageMilliseconds,
      eligible: !installActive && !young,
      name: entry.name,
      path: join(directory, entry.name),
      reason: installActive ? "bun install running" : young ? "younger than 60m" : "older than 60m",
      sizeKilobytes: null,
    };
  });
}

/** Clone ids referenced by any open file or mapped executable (`lsof -Fn`). */
export function heldClones(lsofOutput: string): Set<string> {
  return new Set(lsofOutput.match(/code_sign_clone\.[A-Za-z0-9]+/gu) ?? []);
}

export function bunInstallActive(psOutput: string): boolean {
  return psOutput.split("\n").some((line) =>
    /(^|\/)bunx?\s+(install|add|i|update)\b/u.test(line.trim()) || /\bbun\s+pm\s+/u.test(line));
}

export function darwinTemporaryDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const result = spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value === "" ? (environment.TMPDIR ?? tmpdir()) : value;
}

/** `$TMPDIR/../X/com.google.Chrome.code_sign_clone` */
export function cloneDirectory(temporaryDirectory: string): string {
  let base = temporaryDirectory.replace(/\/+$/u, "");
  try {
    base = realpathSync(base);
  } catch {
    // keep as given
  }
  return join(dirname(base), "X", "com.google.Chrome.code_sign_clone");
}

function directorySize(path: string): number | null {
  const result = spawnSync("du", ["-sk", "-x", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 120_000,
  });
  const value = Number.parseInt(result.stdout ?? "", 10);
  return Number.isSafeInteger(value) ? value : null;
}

export type JanitorReport = {
  readonly bunStaging: { readonly directory: string; readonly installActive: boolean; readonly candidates: readonly Candidate[] };
  readonly clones: { readonly directory: string; readonly candidates: readonly Candidate[] };
  readonly freeBytes: number;
  readonly generatedAt: string;
};

export function janitorReport(options: {
  readonly cloneRoot: string;
  readonly lsofOutput: string;
  readonly now?: number;
  readonly psOutput: string;
  readonly sizes: boolean;
  readonly temporaryDirectory: string;
}): JanitorReport {
  const now = options.now ?? Date.now();
  const size = (candidate: Candidate): Candidate =>
    options.sizes && candidate.eligible ? { ...candidate, sizeKilobytes: directorySize(candidate.path) } : candidate;
  const clones = classifyClones(
    options.cloneRoot,
    listEntries(options.cloneRoot, cloneName),
    heldClones(options.lsofOutput),
    now,
  ).map(size);
  const installActive = bunInstallActive(options.psOutput);
  const bunStaging = classifyBunStaging(
    options.temporaryDirectory,
    listEntries(options.temporaryDirectory, bunStagingName),
    installActive,
    now,
  ).map(size);
  let free = 0;
  try {
    free = freeBytes();
  } catch {
    // statfs unavailable
  }
  return {
    bunStaging: { candidates: bunStaging, directory: options.temporaryDirectory, installActive },
    clones: { candidates: clones, directory: options.cloneRoot },
    freeBytes: free,
    generatedAt: new Date(now).toISOString(),
  };
}

function totalKilobytes(candidates: readonly Candidate[]): number {
  return candidates.reduce((sum, candidate) => sum + (candidate.eligible ? candidate.sizeKilobytes ?? 0 : 0), 0);
}

export function janitorSummary(report: JanitorReport): string {
  const clones = report.clones.candidates;
  const staging = report.bunStaging.candidates;
  const eligibleClones = clones.filter((candidate) => candidate.eligible);
  const eligibleStaging = staging.filter((candidate) => candidate.eligible);
  return [
    `${report.generatedAt}`,
    `free=${formatBytes(report.freeBytes)}`,
    `code_sign_clone total=${clones.length} held=${clones.filter((c) => c.reason === "held open").length}`
    + ` young=${clones.filter((c) => c.reason === "younger than 12h").length} eligible=${eligibleClones.length}`
    + ` eligible-size=${formatBytes(totalKilobytes(clones) * 1024)}`,
    `bun-staging total=${staging.length} eligible=${eligibleStaging.length}`
    + ` eligible-size=${formatBytes(totalKilobytes(staging) * 1024)}`
    + `${report.bunStaging.installActive ? " (bun install running)" : ""}`,
  ].join("\t");
}

export function formatJanitorReport(report: JanitorReport): string {
  const lines = [
    "hra-disk-guard janitor --report (report only; nothing was deleted)",
    janitorSummary(report).split("\t").join("\n"),
    "",
    `Chrome code_sign_clone copies in ${report.clones.directory}:`,
  ];
  const age = (milliseconds: number): string => `${(milliseconds / 3_600_000).toFixed(1)}h`;
  for (const candidate of report.clones.candidates.filter((c) => c.eligible).sort((a, b) => b.ageMilliseconds - a.ageMilliseconds)) {
    lines.push(`  ${candidate.name}\t${age(candidate.ageMilliseconds)}\t${candidate.sizeKilobytes === null ? "?" : formatBytes(candidate.sizeKilobytes * 1024)}`);
  }
  lines.push("", `bun staging directories in ${report.bunStaging.directory}:`);
  for (const candidate of report.bunStaging.candidates.filter((c) => c.eligible).slice(0, 50)) {
    lines.push(`  ${candidate.name}\t${age(candidate.ageMilliseconds)}\t${candidate.sizeKilobytes === null ? "?" : formatBytes(candidate.sizeKilobytes * 1024)}`);
  }
  return lines.join("\n");
}

/** Scratchpads (/private/tmp/claude-<uid>/<project>/<session>/scratchpad) and ~/Documents worktrees. */
export function sizeCandidates(
  userHome = homedir(),
  scratchRoot = join("/private/tmp", `claude-${process.getuid?.() ?? 501}`),
): string[] {
  const candidates: string[] = [];
  for (const project of safeList(scratchRoot)) {
    for (const session of safeList(join(scratchRoot, project))) {
      const scratchpad = join(scratchRoot, project, session, "scratchpad");
      if (existsSync(scratchpad)) candidates.push(scratchpad);
    }
  }
  const documents = join(userHome, "Documents");
  for (const name of safeList(documents)) {
    const path = join(documents, name);
    if (existsSync(join(path, ".git"))) candidates.push(path);
  }
  return candidates;
}

function safeList(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

export function topDirectories(
  paths: readonly string[],
  measure: (path: string) => number | null,
  top = 10,
): { readonly path: string; readonly sizeKilobytes: number }[] {
  return paths
    .map((path) => ({ path, sizeKilobytes: measure(path) ?? 0 }))
    .sort((left, right) => right.sizeKilobytes - left.sizeKilobytes)
    .slice(0, top);
}

export function reportDue(stateRoot: string, now = Date.now()): boolean {
  try {
    const last = JSON.parse(readFileSync(join(stateRoot, "last-report.json"), "utf8")) as { at?: string };
    return now - Date.parse(last.at ?? "") >= reportIntervalMilliseconds;
  } catch {
    return true;
  }
}

function sizeReport(stateRoot: string, top: number): string {
  const rows = topDirectories(sizeCandidates(), directorySize, top);
  const now = new Date();
  const text = [
    `hra-disk-guard report ${now.toISOString()} (top ${top} scratchpads/worktrees; report only)`,
    `free ${formatBytes(freeBytes())}`,
    ...rows.map((row) => `${formatBytes(row.sizeKilobytes * 1024)}\t${row.path}`),
  ].join("\n");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateRoot, `report-${now.toISOString().slice(0, 10)}.txt`), `${text}\n`, { mode: 0o600 });
  writeFileSync(join(stateRoot, "last-report.json"), `${JSON.stringify({ at: now.toISOString() })}\n`, { mode: 0o600 });
  return text;
}

function run(command: string, arguments_: readonly string[]): string {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 120_000,
  });
  return result.stdout ?? "";
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return arguments_.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function liveJanitorReport(arguments_: readonly string[]): JanitorReport {
  const temporaryDirectory = option(arguments_, "tmpdir") ?? darwinTemporaryDirectory();
  return janitorReport({
    cloneRoot: option(arguments_, "clone-root") ?? cloneDirectory(temporaryDirectory),
    lsofOutput: run("lsof", ["-nP", "-Fn"]),
    psOutput: run("ps", ["-ww", "-axo", "command="]),
    sizes: !arguments_.includes("--no-sizes"),
    temporaryDirectory,
  });
}

function usage(): string {
  return [
    "Usage: hra-disk-guard check [--hook] [--warn-gib=60]",
    "       hra-disk-guard report [--force] [--top=10]",
    "       hra-disk-guard janitor --report [--json] [--no-sizes]",
    "       hra-disk-guard scheduled",
  ].join("\n");
}

export async function main(arguments_: readonly string[]): Promise<number> {
  const [command = "check", ...rest] = arguments_;
  const stateRoot = resolveDiskStateRoot();
  if (command === "check") {
    const threshold = Number(option(rest, "warn-gib") ?? warnFreeGibibytes);
    let warning: string | null = null;
    try {
      warning = headroomWarning(freeBytes(), Number.isFinite(threshold) ? threshold : warnFreeGibibytes);
    } catch {
      warning = null;
    }
    if (rest.includes("--hook")) {
      const output = hookOutput(warning);
      if (output !== "") console.log(output);
    } else if (warning !== null) console.error(`[hra-disk-guard] ${warning}`);
    return 0;
  }
  if (command === "janitor") {
    if (!rest.includes("--report")) {
      console.error("[hra-disk-guard] the janitor is report-only; pass --report (there is no deletion mode)");
      return 2;
    }
    const report = liveJanitorReport(rest);
    console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : formatJanitorReport(report));
    return 0;
  }
  if (command === "report") {
    if (!rest.includes("--force") && !reportDue(stateRoot)) {
      console.log("[hra-disk-guard] daily report already produced; pass --force to rerun");
      return 0;
    }
    console.log(sizeReport(stateRoot, Number(option(rest, "top") ?? 10)));
    return 0;
  }
  if (command === "scheduled") {
    const report = liveJanitorReport(rest);
    const warning = headroomWarning(report.freeBytes);
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(stateRoot, "janitor.log"),
      `${janitorSummary(report)}${warning === null ? "" : "\tLOW-DISK"}\n`,
      { mode: 0o600 },
    );
    if (reportDue(stateRoot)) sizeReport(stateRoot, 10);
    return 0;
  }
  console.error(usage());
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[hra-disk-guard] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
