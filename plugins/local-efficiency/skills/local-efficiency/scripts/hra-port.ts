#!/usr/bin/env bun

// hra-port: a deterministic TCP port per worktree and service name.
//
//   next dev -H 127.0.0.1 -p "${PORT:-$(hra-port web)}"
//
// The same worktree and name always get the same port unless another worktree
// holds it (or something else is listening), in which case the next free port
// in the range is leased instead. Each lease is a small JSON file under
// ~/.local/state/local-efficiency/ports-v1/ that dev-server-reap reads to tell
// a leased dev server from an orphan. Leases for missing worktrees, or ones not
// renewed for a week, are overwritten when their port is needed; this command
// never deletes anything and never stops a process.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const portRangeStart = 20_000;
export const portRangeSize = 20_000;
export const leaseStaleMilliseconds = 7 * 24 * 60 * 60_000;
const maximumProbes = 64;

export type PortLease = {
  readonly createdAt: string;
  readonly name: string;
  readonly port: number;
  readonly renewedAt: string;
  readonly requesterPid: number;
  readonly version: 1;
  readonly worktree: string;
};

export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function preferredPort(worktree: string, name: string): number {
  return portRangeStart + (fnv1a32(`${worktree}:${name}`) % portRangeSize);
}

export function probeSequence(worktree: string, name: string, count = maximumProbes): number[] {
  const first = preferredPort(worktree, name) - portRangeStart;
  return Array.from({ length: count }, (_, index) => portRangeStart + ((first + index) % portRangeSize));
}

export function requireServiceName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
    throw new Error("service name must be 1-64 ASCII letters, digits, '.', '_' or '-'");
  }
  return name;
}

export function resolvePortStateRoot(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.LOCAL_EFFICIENCY_PORTS_ROOT;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) throw new Error("LOCAL_EFFICIENCY_PORTS_ROOT must be absolute");
    return resolve(configured);
  }
  const xdgState = environment.XDG_STATE_HOME;
  if (xdgState !== undefined && xdgState !== "") {
    if (!isAbsolute(xdgState)) throw new Error("XDG_STATE_HOME must be absolute");
    return join(resolve(xdgState), "local-efficiency", "ports-v1");
  }
  return join(resolve(userHome), ".local", "state", "local-efficiency", "ports-v1");
}

/** The Git worktree root containing `cwd`, or `cwd` itself outside Git. */
export function resolveWorktree(cwd: string): string {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const top = result.status === 0 ? result.stdout.trim() : "";
  const chosen = top === "" ? cwd : top;
  try {
    return realpathSync(chosen);
  } catch {
    return resolve(chosen);
  }
}

function leasePath(root: string, port: number): string {
  return join(root, `${port}.json`);
}

export function readLease(root: string, port: number): PortLease | null {
  try {
    const parsed = JSON.parse(readFileSync(leasePath(root, port), "utf8")) as PortLease;
    if (
      parsed.version !== 1
      || parsed.port !== port
      || typeof parsed.worktree !== "string"
      || typeof parsed.name !== "string"
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readLeases(root: string): PortLease[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const leases: PortLease[] = [];
  for (const name of names) {
    const match = /^([0-9]{1,5})\.json$/u.exec(name);
    if (match === null) continue;
    const lease = readLease(root, Number(match[1]));
    if (lease !== null) leases.push(lease);
  }
  return leases.sort((left, right) => left.port - right.port);
}

export function leaseIsLive(
  lease: PortLease,
  now = new Date(),
  worktreeExists: (path: string) => boolean = existsSync,
): boolean {
  const renewed = Date.parse(lease.renewedAt);
  return worktreeExists(lease.worktree)
    && Number.isFinite(renewed)
    && now.getTime() - renewed < leaseStaleMilliseconds;
}

function writeLease(root: string, lease: PortLease): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = leasePath(root, lease.port);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

export type AllocateOptions = {
  readonly isFree: (port: number) => boolean | Promise<boolean>;
  readonly now?: Date;
  readonly requesterPid?: number;
  readonly root: string;
  readonly worktreeExists?: (path: string) => boolean;
};

/** Returns the leased port for worktree+name, renewing or creating its lease. */
export async function allocatePort(
  worktree: string,
  name: string,
  options: AllocateOptions,
): Promise<number> {
  requireServiceName(name);
  const now = options.now ?? new Date();
  const worktreeExists = options.worktreeExists ?? existsSync;
  const lease = (port: number, previous: PortLease | null): PortLease => ({
    createdAt: previous?.createdAt ?? now.toISOString(),
    name,
    port,
    renewedAt: now.toISOString(),
    requesterPid: options.requesterPid ?? process.ppid,
    version: 1,
    worktree,
  });
  const owned = readLeases(options.root)
    .find((entry) => entry.worktree === worktree && entry.name === name);
  if (owned !== undefined) {
    writeLease(options.root, lease(owned.port, owned));
    return owned.port;
  }
  for (const port of probeSequence(worktree, name)) {
    const existing = readLease(options.root, port);
    if (existing !== null && leaseIsLive(existing, now, worktreeExists)) continue;
    if (!(await options.isFree(port))) continue;
    writeLease(options.root, lease(port, null));
    return port;
  }
  throw new Error(`no free port for ${name} after ${maximumProbes} probes`);
}

function connects(port: number, host: string): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = createConnection({ host, port });
    const finish = (value: boolean): void => {
      socket.destroy();
      resolveConnect(value);
    };
    socket.setTimeout(300, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function binds(port: number, host: string): Promise<boolean> {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once("error", () => resolveBind(false));
    server.listen({ exclusive: true, host, port }, () => {
      server.close(() => resolveBind(true));
    });
  });
}

/** Free when nothing answers on loopback and 127.0.0.1 can be bound. */
export async function portIsFree(port: number): Promise<boolean> {
  if (await connects(port, "127.0.0.1")) return false;
  return binds(port, "127.0.0.1");
}

function usage(): string {
  return "Usage: hra-port NAME [--worktree=PATH] [--json]\n       hra-port --list [--json]";
}

async function main(arguments_: readonly string[]): Promise<number> {
  let json = false;
  let list = false;
  let worktreeArgument: string | undefined;
  const names: string[] = [];
  for (const argument of arguments_) {
    if (argument === "--json") json = true;
    else if (argument === "--list") list = true;
    else if (argument.startsWith("--worktree=")) worktreeArgument = argument.slice("--worktree=".length);
    else if (argument === "-h" || argument === "--help") {
      console.log(usage());
      return 0;
    } else if (argument.startsWith("-")) throw new Error(`unknown argument: ${argument}`);
    else names.push(argument);
  }
  const root = resolvePortStateRoot();
  if (list) {
    const leases = readLeases(root).map((lease) => ({ ...lease, live: leaseIsLive(lease) }));
    if (json) console.log(JSON.stringify(leases, null, 2));
    else {
      for (const lease of leases) {
        console.log(`${lease.port}\t${lease.name}\t${lease.live ? "live" : "stale"}\t${lease.worktree}`);
      }
    }
    return 0;
  }
  if (names.length !== 1 || names[0] === undefined) throw new Error(usage());
  const worktree = worktreeArgument === undefined
    ? resolveWorktree(process.cwd())
    : resolveWorktree(resolve(worktreeArgument));
  const port = await allocatePort(worktree, names[0], { isFree: portIsFree, root });
  if (json) console.log(JSON.stringify({ name: names[0], port, worktree }));
  else console.log(String(port));
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[hra-port] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
