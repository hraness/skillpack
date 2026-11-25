/**
 * The HostRun UI helper app for forwarded mac-ui runs.
 *
 * macOS attributes a launchd job's privacy permissions (Accessibility,
 * Screen Recording, Input Monitoring, Automation) to the program launchd
 * started. Without the helper that program is /bin/bash, and granting it would
 * give every shell on the machine screen control. On a host with the helper
 * installed and configured, the remote driver starts each forwarded mac-ui job
 * through `HostRun UI.app` instead, so the owner grants the permissions to
 * that one app. See scripts/mac-ui-helper/host-run-ui.c for what the app
 * accepts and refuses.
 *
 * Grants made to an ad-hoc signed app are tied to its code hash. The install
 * step therefore rebuilds only when the helper's own source changes (it
 * records a source digest inside the bundle), never on an ordinary host-run
 * update or a compiler update.
 */

import { dlopen, FFIType } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const helperBundleId = "com.hraness.host-run-ui";
export const helperExecutableName = "host-run-ui";
export const helperSourceDirectory = join(import.meta.dir, "mac-ui-helper");
const digestVersion = "host-run-ui build 1";

export function defaultHelperAppPath(home = homedir()): string {
  return join(home, "Applications", "HostRun UI.app");
}

export function helperConfigPath(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  home = homedir(),
): string {
  const explicit = environment.LOCAL_EFFICIENCY_MAC_UI_CONFIG?.trim();
  if (explicit) return explicit;
  const configHome = environment.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(configHome, "host-run", "mac-ui.json");
}

export function helperExecutablePath(appPath: string): string {
  return join(appPath, "Contents", "MacOS", helperExecutableName);
}

function installedDigestPath(appPath: string): string {
  return join(appPath, "Contents", "Resources", "source-digest");
}

/** Digest of everything that goes into the bundle; a change here means a new code hash. */
export function helperSourceDigest(sourceDirectory = helperSourceDirectory): string {
  const hash = createHash("sha256");
  hash.update(digestVersion);
  for (const name of ["host-run-ui.c", "Info.plist"]) {
    hash.update(`\0${name}\0`);
    hash.update(readFileSync(join(sourceDirectory, name)));
  }
  return hash.digest("hex");
}

export type HelperConfig = { readonly app: string };

export function parseHelperConfig(text: string, source = "mac-ui.json"): HelperConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  const helper = (parsed as { helper?: { app?: unknown } } | null)?.helper;
  if (typeof helper?.app !== "string" || !helper.app.startsWith("/") || !helper.app.endsWith(".app")) {
    throw new Error(`${source} needs helper.app: an absolute path to HostRun UI.app`);
  }
  return { app: helper.app };
}

type RunResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };
export type CommandRunner = (program: string, arguments_: readonly string[]) => RunResult;

const systemRunner: CommandRunner = (program, arguments_) => {
  const result = spawnSync(program, [...arguments_], { encoding: "utf8", timeout: 120_000 });
  return {
    status: result.status,
    stderr: result.error ? String(result.error.message) : result.stderr,
    stdout: result.stdout ?? "",
  };
};

export type HelperStatus = {
  readonly app: string;
  readonly cdhash: string | null;
  readonly identifier: string | null;
  readonly installedDigest: string | null;
  readonly problem: string | null;
  readonly sourceDigest: string;
  readonly upToDate: boolean;
};

export function inspectHelper(appPath: string, run: CommandRunner = systemRunner): HelperStatus {
  const sourceDigest = helperSourceDigest();
  const base = { app: appPath, cdhash: null, identifier: null, installedDigest: null, sourceDigest, upToDate: false };
  if (!existsSync(helperExecutablePath(appPath))) return { ...base, problem: "not installed" };
  const installedDigest = existsSync(installedDigestPath(appPath))
    ? readFileSync(installedDigestPath(appPath), "utf8").trim()
    : null;
  const verify = run("/usr/bin/codesign", ["--verify", "--strict", appPath]);
  const details = run("/usr/bin/codesign", ["--display", "--verbose=4", appPath]);
  const text = `${details.stdout}\n${details.stderr}`;
  const identifier = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const cdhash = /^CDHash=([0-9a-f]+)$/m.exec(text)?.[1] ?? null;
  let problem: string | null = null;
  if (verify.status !== 0) problem = `signature does not verify: ${verify.stderr.trim().split("\n").pop() ?? ""}`;
  else if (identifier !== helperBundleId) problem = `signed as ${identifier ?? "unknown"}, expected ${helperBundleId}`;
  return {
    app: appPath,
    cdhash,
    identifier,
    installedDigest,
    problem,
    sourceDigest,
    upToDate: problem === null && installedDigest === sourceDigest,
  };
}

export type InstallResult = { readonly changed: boolean; readonly status: HelperStatus; readonly configWritten: boolean };

/**
 * Builds and ad-hoc signs HostRun UI.app at `appPath` when its recorded source
 * digest differs from the checked-in source, swaps it in atomically, and
 * records it in the host's mac-ui.json. Re-running with unchanged source
 * changes nothing, so the owner's grants stay valid.
 */
export function installHelper(options: {
  readonly appPath: string;
  readonly configPath: string;
  readonly log?: (line: string) => void;
  readonly run?: CommandRunner;
}): InstallResult {
  const run = options.run ?? systemRunner;
  const log = options.log ?? ((line: string) => console.log(line));
  if (process.platform !== "darwin") throw new Error("HostRun UI is a macOS app; install it on the Mac that runs mac-ui jobs");
  let status = inspectHelper(options.appPath, run);
  let changed = false;
  if (!status.upToDate) {
    const staging = `${options.appPath}.new-${process.pid}`;
    rmSync(staging, { force: true, recursive: true });
    try {
      mkdirSync(join(staging, "Contents", "MacOS"), { recursive: true });
      mkdirSync(join(staging, "Contents", "Resources"), { recursive: true });
      copyFileSync(join(helperSourceDirectory, "Info.plist"), join(staging, "Contents", "Info.plist"));
      writeFileSync(installedDigestPath(staging), `${status.sourceDigest}\n`);
      const compile = run("/usr/bin/xcrun", [
        "clang", "-O2", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0",
        "-o", helperExecutablePath(staging), join(helperSourceDirectory, "host-run-ui.c"),
      ]);
      if (compile.status !== 0) throw new Error(`could not compile HostRun UI (needs the Xcode command line tools): ${compile.stderr.trim()}`);
      const sign = run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", helperBundleId, "--timestamp=none", staging]);
      if (sign.status !== 0) throw new Error(`could not ad-hoc sign HostRun UI: ${sign.stderr.trim()}`);
      const staged = inspectHelper(staging, run);
      if (staged.problem !== null) throw new Error(`the new HostRun UI build is broken: ${staged.problem}`);
      mkdirSync(dirname(options.appPath), { recursive: true });
      const previous = `${options.appPath}.old-${process.pid}`;
      if (existsSync(options.appPath)) renameSync(options.appPath, previous);
      renameSync(staging, options.appPath);
      rmSync(previous, { force: true, recursive: true });
    } finally {
      rmSync(staging, { force: true, recursive: true });
    }
    changed = true;
    status = inspectHelper(options.appPath, run);
    if (!status.upToDate) throw new Error(`HostRun UI did not install cleanly: ${status.problem ?? "source digest mismatch"}`);
  }
  let configWritten = false;
  let current: HelperConfig | null = null;
  if (existsSync(options.configPath)) current = parseHelperConfig(readFileSync(options.configPath, "utf8"), options.configPath);
  if (current?.app !== options.appPath) {
    mkdirSync(dirname(options.configPath), { recursive: true });
    writeFileSync(options.configPath, `${JSON.stringify({ helper: { app: options.appPath } }, null, 2)}\n`);
    configWritten = true;
  }
  log(changed
    ? `[host-run] installed ${options.appPath} (${helperBundleId}, cdhash ${status.cdhash ?? "unknown"}); grant it again in System Settings if it was granted before`
    : `[host-run] ${options.appPath} is up to date (cdhash ${status.cdhash ?? "unknown"}); existing grants still apply`);
  if (configWritten) log(`[host-run] forwarded mac-ui runs on this Mac now start through it (${options.configPath})`);
  return { changed, configWritten, status };
}

export function formatHelperStatus(status: HelperStatus, configPath: string, configured: boolean): string {
  return [
    `config\t${configured ? configPath : `${configPath} (absent: forwarded runs start through /bin/bash)`}`,
    `app\t${status.app}`,
    `state\t${status.problem ?? (status.upToDate ? "installed, up to date" : "installed, older than this host-run's source")}`,
    `identifier\t${status.identifier ?? "-"}`,
    `cdhash\t${status.cdhash ?? "-"}`,
  ].join("\n");
}

// ---- permission probe ----

export type ProbeLine = { readonly name: string; readonly granted: boolean; readonly detail: string };

function preflight(library: string, symbol: string): ProbeLine {
  try {
    const handle = dlopen(library, { [symbol]: { args: [], returns: FFIType.bool } });
    const granted = Boolean((handle.symbols[symbol] as () => boolean)());
    handle.close();
    return { detail: granted ? "granted" : "not granted", granted, name: symbol };
  } catch (error) {
    return { detail: `could not check: ${error instanceof Error ? error.message : String(error)}`, granted: false, name: symbol };
  }
}

function uiScriptingProbe(run: CommandRunner): ProbeLine {
  const result = run("/usr/bin/osascript", [
    "-e", "with timeout of 15 seconds",
    "-e", "tell application \"System Events\" to get name of every UI element of first application process whose frontmost is true",
    "-e", "end timeout",
  ]);
  if (result.status === 0) return { detail: "granted", granted: true, name: "UI scripting (System Events)" };
  const message = result.stderr.trim().split("\n").pop() ?? "";
  const reason = /-1743/.test(message)
    ? "Automation for System Events not granted"
    : /-25211/.test(message)
      ? "Accessibility not granted"
      : /-1712/.test(message)
        ? "timed out (an Automation prompt may be waiting on screen)"
        : "failed";
  return { detail: `${reason}: ${message}`, granted: false, name: "UI scripting (System Events)" };
}

function processChain(run: CommandRunner): string {
  const names: string[] = [];
  let pid = process.pid;
  for (let depth = 0; depth < 12 && pid > 0; depth += 1) {
    const result = run("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
    const match = /^\s*(\d+)\s+(.+)$/.exec(result.stdout.trim());
    if (!match) break;
    names.push(match[2].trim());
    if (pid === 1) break;
    pid = Number(match[1]);
  }
  return names.join(" <- ");
}

export function runPermissionProbe(run: CommandRunner = systemRunner): { readonly lines: readonly ProbeLine[]; readonly text: string } {
  const applicationServices = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
  const coreGraphics = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
  const lines = [
    { ...preflight(applicationServices, "AXIsProcessTrusted"), name: "Accessibility (AXIsProcessTrusted)" },
    { ...preflight(coreGraphics, "CGPreflightScreenCaptureAccess"), name: "Screen Recording (CGPreflightScreenCaptureAccess)" },
    { ...preflight(coreGraphics, "CGPreflightPostEventAccess"), name: "Post events (CGPreflightPostEventAccess)" },
    { ...preflight(coreGraphics, "CGPreflightListenEventAccess"), name: "Input Monitoring (CGPreflightListenEventAccess)" },
    uiScriptingProbe(run),
  ];
  const width = Math.max(...lines.map((line) => line.name.length));
  const text = [
    `user\t${process.env.USER ?? "unknown"}`,
    `launchd job\t${process.env.XPC_SERVICE_NAME ?? "none"}`,
    `process chain\t${processChain(run)}`,
    ...lines.map((line) => `${line.name.padEnd(width)}  ${line.detail}`),
  ].join("\n");
  return { lines, text };
}
