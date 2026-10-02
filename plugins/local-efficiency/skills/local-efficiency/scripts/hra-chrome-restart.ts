#!/usr/bin/env bun

// hra-chrome-restart: gracefully recycle the user's signed-in Google Chrome
// when its process state goes stale — e.g. an in-place update leaves the
// running binary's kernel path unresolvable, which fails process census in
// unrelated agent tooling. SIGTERM lets Chrome save its session and exit
// cleanly; `open -a` relaunches through LaunchServices, never as a child of
// this shell, so the browser keeps its user-owned lifetime. The command
// refuses when Chrome is not running and never force-kills: a Chrome that
// ignores TERM is reported, not SIGKILLed.
//
//   host-run --lane=browser-auth -- hra-chrome-restart
//
// Test seams: HRA_CHROME_RESTART_APP_DIR relocates the .app directory and
// HRA_CHROME_RESTART_OPEN replaces /usr/bin/open.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

const quitDeadlineMs = 30_000;
const relaunchDeadlineMs = 30_000;
const pollIntervalMs = 250;

export interface ProcessRow {
  readonly pid: number;
  readonly stat: string;
  readonly command: string;
}

export function parseProcessTable(text: string): readonly ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\S.*)$/.exec(line);
    if (match === null) continue;
    rows.push({ pid: Number(match[1]), stat: match[2] ?? "", command: match[3] ?? "" });
  }
  return rows;
}

export function chromeFamily(rows: readonly ProcessRow[], binaryPath: string): { readonly mains: number[]; readonly family: number[] } {
  const family = rows
    .filter((row) => !row.stat.startsWith("Z") && (row.command === binaryPath || row.command.startsWith(binaryPath + " ")))
    .map((row) => row.pid);
  return { family, mains: rows.filter((row) => family.includes(row.pid) && !row.command.includes(" --type=")).map((row) => row.pid) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kernel check that the new main process has a resolvable executable path. */
function executableResolves(pid: number): boolean {
  const { proc_pidpath } = dlopen("/usr/lib/libproc.dylib", {
    proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  }).symbols;
  const path = Buffer.alloc(4096);
  return proc_pidpath(pid, ptr(path), path.length) > 0;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("hra-chrome-restart manages macOS Google Chrome only");
  const appDir = process.env.HRA_CHROME_RESTART_APP_DIR ?? "/Applications/Google Chrome.app";
  const opener = process.env.HRA_CHROME_RESTART_OPEN ?? "/usr/bin/open";
  let binaryPath: string;
  try {
    binaryPath = join(realpathSync(appDir), "Contents/MacOS/Google Chrome");
  } catch {
    binaryPath = join(appDir, "Contents/MacOS/Google Chrome");
  }
  const list = () => chromeFamily(parseProcessTable(spawnSync("ps", ["-axo", "pid=,stat=,command="], { encoding: "utf8" }).stdout), binaryPath);

  const initial = list();
  if (initial.family.length === 0) {
    console.error("hra-chrome-restart: Google Chrome is not running; refusing to launch it");
    process.exit(2);
  }
  const targets = initial.mains.length > 0 ? initial.mains : initial.family;
  console.log(`hra-chrome-restart: terminating ${targets.join(", ")}`);
  for (const pid of targets) process.kill(pid, "SIGTERM");

  const quitDeadline = Date.now() + quitDeadlineMs;
  while (list().family.length > 0) {
    if (Date.now() >= quitDeadline) {
      const surviving = list().family;
      throw new Error(`Chrome did not exit within ${quitDeadlineMs / 1000}s; ${surviving.length} process(es) remain — quit it manually, refusing to force-kill`);
    }
    await sleep(pollIntervalMs);
  }

  const open = spawnSync(opener, ["-a", basename(appDir, ".app")], { encoding: "utf8" });
  if (open.status !== 0) throw new Error(`Chrome relaunch failed: ${open.stderr.trim() || `exit ${open.status}`}`);

  const relaunchDeadline = Date.now() + relaunchDeadlineMs;
  for (;;) {
    const fresh = list().mains;
    if (fresh.length > 0) {
      const pid = fresh[0] as number;
      if (!executableResolves(pid)) throw new Error(`relaunched Chrome pid ${pid} still has an unresolvable executable path`);
      console.log(`hra-chrome-restart: relaunched pid ${pid}, executable record verified`);
      return;
    }
    if (Date.now() >= relaunchDeadline) throw new Error(`no Chrome main process within ${relaunchDeadlineMs / 1000}s of relaunch`);
    await sleep(pollIntervalMs);
  }
}

if (import.meta.main) await main().catch((error: unknown) => {
  console.error(`hra-chrome-restart: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
