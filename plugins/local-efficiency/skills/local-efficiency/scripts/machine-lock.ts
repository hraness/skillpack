/**
 * An optional machine-wide CI lock that `mac-ui` runs hold shared for the
 * whole command, so UI work never overlaps a timed benchmark on a Mac that
 * also runs CI.
 *
 * This speaks the same protocol as the CI runners' `ci-machine-lock.py`
 * (oh-app `.github/scripts/ci-machine-lock.py`), so the two interoperate:
 *
 * - The lock is `flock(2)` on `PATH`, and the gate is `flock(2)` on
 *   `PATH.gate`. Both files are opened read-write and created world-writable
 *   if missing; existing files and their permissions are never changed.
 * - A shared holder takes the gate shared, then the lock shared, then drops
 *   the gate, so it queues behind an exclusive holder waiting at the gate.
 *   An exclusive holder keeps the gate, so new shared holders wait for its
 *   measurement. host-run only ever takes the shared side.
 * - One deadline covers the gate and the lock; both are polled with
 *   `LOCK_NB` every 100 ms.
 * - The descriptors are close-on-exec and held only by host-run, never by
 *   the command, and the kernel drops the locks when host-run exits for any
 *   reason.
 *
 * The protocol is implemented here rather than by running the runner's own
 * copy, because that file belongs to the CI user, and running a file another
 * account can write would hand that account this one.
 */

import { mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { dlopen, FFIType, read } from "bun:ffi";

export const machineLockTimeoutExitCode = 76;
export const machineLockTimeoutCode = "MACHINE_LOCK_TIMEOUT";
export const maxMachineLockWaitSeconds = 2 * 60 * 60;
const pollMilliseconds = 100;

const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;
const EINTR = 4;

export type MachineLockConfig = {
  readonly mode: "shared";
  readonly path: string;
  readonly source: string;
  readonly waitTimeoutMilliseconds: number;
};

export class MachineLockTimeoutError extends Error {
  readonly code = machineLockTimeoutCode;
  constructor(message: string) {
    super(message);
    this.name = "MachineLockTimeoutError";
  }
}

export function machineLockConfigPath(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const xdg = environment.XDG_CONFIG_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(environment.HOME ?? userHome, ".config");
  return join(base, "host-run", "machine-lock.json");
}

/**
 * `{ "macUi": { "path": ABSOLUTE, "mode": "shared", "waitTimeoutSeconds": N } }`.
 * Only shared mode is accepted: host-run never takes the lock exclusive.
 */
export function parseMachineLockConfig(text: string, source = "machine-lock.json"): MachineLockConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object`);
  }
  const root = parsed as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== "macUi") throw new Error(`${source} has an unknown key: ${key}`);
  }
  if (root.macUi === undefined) return null;
  const entry = root.macUi;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${source}: macUi must be an object`);
  }
  const lock = entry as Record<string, unknown>;
  for (const key of Object.keys(lock)) {
    if (key !== "path" && key !== "mode" && key !== "waitTimeoutSeconds") {
      throw new Error(`${source}: macUi has an unknown key: ${key}`);
    }
  }
  if (
    typeof lock.path !== "string" || !isAbsolute(lock.path) || normalize(lock.path) !== lock.path
    || lock.path.endsWith("/") || /[\0-\x1f\x7f]/u.test(lock.path)
  ) {
    throw new Error(`${source}: macUi.path must be a normalized absolute file path`);
  }
  if (lock.mode !== undefined && lock.mode !== "shared") {
    throw new Error(`${source}: macUi.mode must be "shared"; host-run never takes the machine lock exclusive`);
  }
  const wait = lock.waitTimeoutSeconds ?? 3600;
  if (typeof wait !== "number" || !Number.isFinite(wait) || wait <= 0 || wait > maxMachineLockWaitSeconds) {
    throw new Error(`${source}: macUi.waitTimeoutSeconds must be a number of seconds from 1 to ${maxMachineLockWaitSeconds}`);
  }
  return { mode: "shared", path: lock.path, source, waitTimeoutMilliseconds: Math.round(wait * 1_000) };
}

/**
 * Absent default file means no machine lock. `LOCAL_EFFICIENCY_MACHINE_LOCK_CONFIG`
 * names an explicit file instead, which must exist.
 */
export function resolveMachineLockConfig(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): MachineLockConfig | null {
  const explicit = environment.LOCAL_EFFICIENCY_MACHINE_LOCK_CONFIG;
  const hasExplicit = explicit !== undefined && explicit !== "";
  if (hasExplicit && !isAbsolute(explicit)) throw new Error("LOCAL_EFFICIENCY_MACHINE_LOCK_CONFIG must be absolute");
  const path = hasExplicit ? explicit : machineLockConfigPath(environment, userHome);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (!hasExplicit && typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseMachineLockConfig(text, path);
}

export type FlockApi = {
  /** Returns 0, or the errno of a failed `flock(fd, operation)`. */
  readonly flock: (descriptor: number, operation: number) => number;
};

let libc: FlockApi | null = null;

export function systemFlock(): FlockApi {
  if (libc !== null) return libc;
  const darwin = process.platform === "darwin";
  const library = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [darwin ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
  });
  const symbols = library.symbols as unknown as {
    flock: (descriptor: number, operation: number) => number;
    __error?: () => number | null;
    __errno_location?: () => number | null;
  };
  const errnoPointer = darwin ? symbols.__error! : symbols.__errno_location!;
  libc = {
    flock(descriptor, operation) {
      if (symbols.flock(descriptor, operation) === 0) return 0;
      const pointer = errnoPointer();
      return pointer === null || pointer === 0 ? -1 : read.i32(pointer as never, 0);
    },
  };
  return libc;
}

function openLockFile(path: string): number {
  const previous = process.umask(0);
  try {
    mkdirSync(dirname(path), { mode: 0o777, recursive: true });
    // Node and Bun open files close-on-exec, so the command never inherits it.
    return openSync(path, "a+", 0o666);
  } finally {
    process.umask(previous);
  }
}

export type HeldMachineLock = { readonly release: () => void; readonly waitedMilliseconds: number };

export type AcquireOptions = {
  readonly flock?: FlockApi;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** Polled between attempts; a truthy result cancels the wait. */
  readonly cancelled?: () => boolean;
  readonly exclusiveForTests?: boolean;
};

export function describeHost(): string {
  return hostname().replace(/\.local$/u, "");
}

/**
 * Wait for the shared machine lock. Returns the held lock, `null` when
 * `cancelled()` became true, or throws `MachineLockTimeoutError`.
 */
export async function acquireMachineLock(
  config: MachineLockConfig,
  options: AcquireOptions = {},
): Promise<HeldMachineLock | null> {
  const api = options.flock ?? systemFlock();
  const flock = (descriptor: number, operation: number): number => api.flock(descriptor, operation);
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? ((line: string) => console.error(line));
  const exclusive = options.exclusiveForTests === true;
  const mode = exclusive ? LOCK_EX : LOCK_SH;
  const kind = exclusive ? "exclusive" : "shared";
  const descriptors: number[] = [];
  const closeAll = (): void => {
    for (const descriptor of descriptors.splice(0)) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
  };
  const started = now();
  const deadline = started + config.waitTimeoutMilliseconds;
  let announced = false;
  const take = async (descriptor: number): Promise<"held" | "timeout" | "cancelled"> => {
    for (;;) {
      const error = flock(descriptor, mode | LOCK_NB);
      if (error === 0) return "held";
      if (error !== EWOULDBLOCK && error !== EINTR) {
        throw new Error(`flock on the machine lock failed (errno ${error})`);
      }
      if (!announced) {
        announced = true;
        log(
          `[host-run] waiting for the ${describeHost()} CI machine lock ${config.path}`
          + ` (${kind}; a CI measurement holds or is waiting for it; timeout ${Math.round(config.waitTimeoutMilliseconds / 1_000)} s)`,
        );
      }
      if (options.cancelled?.() === true) return "cancelled";
      if (now() >= deadline) return "timeout";
      await Bun.sleep(pollMilliseconds);
    }
  };
  try {
    const gate = openLockFile(`${config.path}.gate`);
    descriptors.push(gate);
    const lock = openLockFile(config.path);
    descriptors.push(lock);
    for (const descriptor of [gate, lock]) {
      const outcome = await take(descriptor);
      if (outcome === "cancelled") {
        closeAll();
        return null;
      }
      if (outcome === "timeout") {
        closeAll();
        throw new MachineLockTimeoutError(
          `timed out after ${Math.round((now() - started) / 1_000)} s waiting for the ${kind} CI machine lock`
          + ` ${config.path} on ${describeHost()}; a CI measurement is holding it. Nothing ran; retry later`,
        );
      }
    }
    if (!exclusive) flock(gate, LOCK_UN);
    const waitedMilliseconds = now() - started;
    log(`[host-run] holding the ${kind} CI machine lock after waiting ${(waitedMilliseconds / 1_000).toFixed(1)} s`);
    return { release: closeAll, waitedMilliseconds };
  } catch (error: unknown) {
    closeAll();
    throw error;
  }
}
