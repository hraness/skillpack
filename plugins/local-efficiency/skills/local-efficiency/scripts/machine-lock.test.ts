import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MachineLockTimeoutError,
  acquireMachineLock,
  machineLockConfigPath,
  machineLockTimeoutExitCode,
  parseMachineLockConfig,
  resolveMachineLockConfig,
  type MachineLockConfig,
} from "./machine-lock";

/**
 * A CI-side holder that follows the runner's ci-machine-lock.py protocol
 * exactly (gate then lock, one deadline, shared holders drop the gate,
 * exclusive holders keep it). It prints "held" once it holds the lock and
 * releases when its stdin closes.
 */
const ciHolderSource = `
import fcntl, os, sys, time
mode, path = sys.argv[1], sys.argv[2]
def open_lock(p):
    previous = os.umask(0)
    try:
        return os.open(p, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o666)
    finally:
        os.umask(previous)
gate = open_lock(path + ".gate")
lock = open_lock(path)
op = fcntl.LOCK_EX if mode == "exclusive" else fcntl.LOCK_SH
for fd in (gate, lock):
    while True:
        try:
            fcntl.flock(fd, op | fcntl.LOCK_NB)
            break
        except OSError:
            if fd == lock:
                print("gate", flush=True)
            time.sleep(0.05)
if mode != "exclusive":
    fcntl.flock(gate, fcntl.LOCK_UN)
print("held", flush=True)
sys.stdin.read()
`;

/** Exits 0 if the lock can be taken exclusive right now, 1 if it is held. */
const exclusiveProbeSource = `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    sys.exit(0)
except OSError:
    sys.exit(1)
`;

type Holder = { readonly child: ChildProcess; output: string };

function fixture(): { readonly config: MachineLockConfig; readonly root: string; readonly scripts: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "le-machine-lock-")));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  writeFileSync(join(scripts, "ci_holder.py"), ciHolderSource);
  writeFileSync(join(scripts, "probe.py"), exclusiveProbeSource);
  mkdirSync(join(root, "locks"));
  return {
    config: { mode: "shared", path: join(root, "locks", "machine.lock"), source: "test", waitTimeoutMilliseconds: 5_000 },
    root,
    scripts,
  };
}

async function startHolder(scripts: string, mode: "shared" | "exclusive", path: string, until: string): Promise<Holder> {
  const child = spawn("python3", ["-I", join(scripts, "ci_holder.py"), mode, path], { stdio: ["pipe", "pipe", "inherit"] });
  const holder: Holder = { child, output: "" };
  child.stdout!.on("data", (chunk: Buffer) => { holder.output += chunk.toString(); });
  const deadline = Date.now() + 10_000;
  while (!holder.output.includes(until) && Date.now() < deadline) await Bun.sleep(20);
  if (!holder.output.includes(until)) throw new Error(`CI holder never reported ${until}`);
  return holder;
}

async function stopHolder(holder: Holder): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (holder.child.exitCode !== null && holder.child.exitCode !== undefined) resolve();
    else holder.child.once("exit", () => resolve());
  });
  holder.child.stdin!.end();
  const timedOut = await Promise.race([exited.then(() => false), Bun.sleep(10_000).then(() => true)]);
  if (timedOut) throw new Error("CI holder did not exit within 10 s of closing its stdin");
}

function lockHeld(scripts: string, path: string): boolean {
  return Bun.spawnSync({ cmd: ["python3", "-I", join(scripts, "probe.py"), path] }).exitCode === 1;
}

describe("machine lock config", () => {
  test("is read from host-run/machine-lock.json and is absent by default", () => {
    expect(machineLockConfigPath({ HOME: "/opt/home-a" })).toBe("/opt/home-a/.config/host-run/machine-lock.json");
    expect(machineLockConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/opt/home-a" })).toBe("/xdg/host-run/machine-lock.json");
    const root = mkdtempSync(join(tmpdir(), "le-machine-lock-config-"));
    try {
      expect(resolveMachineLockConfig({ XDG_CONFIG_HOME: root })).toBeNull();
      mkdirSync(join(root, "host-run"));
      writeFileSync(join(root, "host-run", "machine-lock.json"),
        JSON.stringify({ macUi: { path: "/opt/ci-lock/machine.lock", mode: "shared", waitTimeoutSeconds: 3600 } }));
      expect(resolveMachineLockConfig({ XDG_CONFIG_HOME: root })).toMatchObject({
        mode: "shared",
        path: "/opt/ci-lock/machine.lock",
        waitTimeoutMilliseconds: 3_600_000,
      });
      expect(resolveMachineLockConfig({ LOCAL_EFFICIENCY_MACHINE_LOCK_CONFIG: join(root, "host-run", "machine-lock.json") }))
        .not.toBeNull();
      expect(() => resolveMachineLockConfig({ LOCAL_EFFICIENCY_MACHINE_LOCK_CONFIG: join(root, "missing.json") })).toThrow("cannot read");
      expect(() => resolveMachineLockConfig({ LOCAL_EFFICIENCY_MACHINE_LOCK_CONFIG: "rel.json" })).toThrow("absolute");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("accepts only shared mode and bounded waits", () => {
    expect(parseMachineLockConfig(JSON.stringify({ macUi: { path: "/l/m.lock" } }))).toMatchObject({ waitTimeoutMilliseconds: 3_600_000 });
    expect(parseMachineLockConfig("{}")).toBeNull();
    expect(() => parseMachineLockConfig(JSON.stringify({ macUi: { path: "/l/m.lock", mode: "exclusive" } }))).toThrow("never takes the machine lock exclusive");
    expect(() => parseMachineLockConfig(JSON.stringify({ macUi: { path: "rel.lock" } }))).toThrow("absolute");
    expect(() => parseMachineLockConfig(JSON.stringify({ macUi: { path: "/l/../m.lock" } }))).toThrow("absolute");
    expect(() => parseMachineLockConfig(JSON.stringify({ macUi: { path: "/l/m.lock", waitTimeoutSeconds: 0 } }))).toThrow("waitTimeoutSeconds");
    expect(() => parseMachineLockConfig(JSON.stringify({ macUi: { path: "/l/m.lock", waitTimeoutSeconds: 99_999 } }))).toThrow("waitTimeoutSeconds");
    expect(() => parseMachineLockConfig(JSON.stringify({ macUi: { path: "/l/m.lock", extra: 1 } }))).toThrow("unknown key");
    expect(() => parseMachineLockConfig(JSON.stringify({ other: {} }))).toThrow("unknown key");
    expect(() => parseMachineLockConfig("nope")).toThrow("not valid JSON");
  });
});

describe("machine lock protocol against a ci-machine-lock.py holder", () => {
  test("holds shared alongside CI builds and blocks a CI measurement until released", async () => {
    const f = fixture();
    try {
      const build = await startHolder(f.scripts, "shared", f.config.path, "held");
      const lines: string[] = [];
      const held = await acquireMachineLock(f.config, { log: (line) => lines.push(line) });
      expect(held).not.toBeNull();
      expect(lines.some((line) => line.includes("waiting for the"))).toBe(false);
      await stopHolder(build);
      expect(lockHeld(f.scripts, f.config.path)).toBe(true);
      held!.release();
      expect(lockHeld(f.scripts, f.config.path)).toBe(false);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  });

  test("waits for a running measurement, says so, and times out with a distinct error", async () => {
    const f = fixture();
    try {
      const measurement = await startHolder(f.scripts, "exclusive", f.config.path, "held");
      const lines: string[] = [];
      const started = performance.now();
      const error = await acquireMachineLock({ ...f.config, waitTimeoutMilliseconds: 400 }, { log: (line) => lines.push(line) })
        .then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(MachineLockTimeoutError);
      expect((error as MachineLockTimeoutError).code).toBe("MACHINE_LOCK_TIMEOUT");
      expect(performance.now() - started).toBeGreaterThanOrEqual(400);
      expect(lines[0]).toContain("CI machine lock");
      expect(lines[0]).toContain("waiting");
      expect(machineLockTimeoutExitCode).toBe(76);
      await stopHolder(measurement);
      const held = await acquireMachineLock(f.config, { log: () => {} });
      expect(held).not.toBeNull();
      held!.release();
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  });

  test("an exclusive holder waiting at the gate blocks a new shared holder", async () => {
    const f = fixture();
    try {
      // A build holds the lock shared; a measurement then takes the gate and waits for the lock.
      const build = await startHolder(f.scripts, "shared", f.config.path, "held");
      const measurement = await startHolder(f.scripts, "exclusive", f.config.path, "gate");
      // The lock itself is only held shared, yet a new shared holder must queue behind the measurement.
      const blocked = await acquireMachineLock({ ...f.config, waitTimeoutMilliseconds: 400 }, { log: () => {} })
        .then(() => "acquired", (caught: unknown) => caught instanceof MachineLockTimeoutError ? "timeout" : String(caught));
      expect(blocked).toBe("timeout");
      // Start waiting again; the measurement runs first once the build ends.
      let ours: Awaited<ReturnType<typeof acquireMachineLock>> | undefined;
      const waiting = acquireMachineLock(f.config, { log: () => {} }).then((held) => { ours = held; });
      await stopHolder(build);
      const deadline = Date.now() + 5_000;
      while (!measurement.output.includes("held") && Date.now() < deadline) await Bun.sleep(20);
      expect(measurement.output).toContain("held");
      await Bun.sleep(300);
      expect(ours).toBeUndefined();
      await stopHolder(measurement);
      await waiting;
      expect(ours).not.toBeNull();
      ours!.release();
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  });

  test("a cancelled wait returns null and holds nothing", async () => {
    const f = fixture();
    try {
      const measurement = await startHolder(f.scripts, "exclusive", f.config.path, "held");
      let cancel = false;
      const waiting = acquireMachineLock(f.config, { cancelled: () => cancel, log: () => {} });
      await Bun.sleep(250);
      cancel = true;
      expect(await waiting).toBeNull();
      await stopHolder(measurement);
      expect(lockHeld(f.scripts, f.config.path)).toBe(false);
      expect(existsSync(`${f.config.path}.gate`)).toBe(true);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  });
});

describe("host-run --lane=mac-ui with a machine lock", () => {
  const hostRunScript = join(import.meta.dir, "host-run.ts");
  const passThroughModule = (root: string): string => {
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, `
      import { appendFileSync, closeSync, openSync } from "node:fs";
      export function createHostResourceCoordinator(options) {
        return {
          async withLease(claims, callback) {
            appendFileSync(${JSON.stringify(join(root, "claims.log"))}, JSON.stringify({ profile: options.profile.id, claims }) + "\\n");
            const descriptor = openSync("/dev/null", "r");
            try { return await callback({ inheritedFileDescriptor: descriptor }); } finally { closeSync(descriptor); }
          },
        };
      }
    `);
    return modulePath;
  };
  const environmentFor = (root: string, config: MachineLockConfig, waitSeconds = 30): NodeJS.ProcessEnv => {
    const configPath = join(root, "machine-lock.json");
    writeFileSync(configPath, JSON.stringify({ macUi: { path: config.path, mode: "shared", waitTimeoutSeconds: waitSeconds } }));
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ATET_HOST_RESOURCES_MODULE: passThroughModule(root),
      LOCAL_EFFICIENCY_MACHINE_LOCK_CONFIG: configPath,
      LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
      LOCAL_EFFICIENCY_TELEMETRY: "off",
      XDG_CONFIG_HOME: join(root, "no-config"),
    };
  };
  const macOnly = test.skipIf(process.platform !== "darwin");

  macOnly("holds the lock for the whole command, not in the command, and releases it afterwards", () => {
    const f = fixture();
    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, hostRunScript, "--lane=mac-ui", "--label=locked", "--", "/bin/sh", "-c",
          `python3 -I ${join(f.scripts, "probe.py")} ${f.config.path}; echo probe=$?; lsof -a -p $$ ${f.config.path} >/dev/null 2>&1; echo child-has-lock=$?`],
        cwd: f.root,
        env: environmentFor(f.root, f.config),
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toContain("probe=1");
      expect(result.stdout.toString()).toContain("child-has-lock=1");
      expect(result.stderr.toString()).toContain("holding the shared CI machine lock");
      expect(lockHeld(f.scripts, f.config.path)).toBe(false);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  });

  macOnly("waits for the lock before claiming the mac-ui lease and fails closed on timeout", async () => {
    const f = fixture();
    try {
      const measurement = await startHolder(f.scripts, "exclusive", f.config.path, "held");
      const marker = join(f.root, "ran");
      const result = Bun.spawnSync({
        cmd: [process.execPath, hostRunScript, "--lane=mac-ui", "--label=blocked", "--", "touch", marker],
        cwd: f.root,
        env: environmentFor(f.root, f.config, 1),
        stderr: "pipe",
        stdout: "pipe",
      });
      await stopHolder(measurement);
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr).toBe(76);
      expect(stderr).toContain("waiting for the");
      expect(stderr).toContain("MACHINE_LOCK_TIMEOUT");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(f.root, "claims.log"))).toBe(false);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  });

  macOnly("an interrupt while waiting or running releases the lock", async () => {
    const f = fixture();
    try {
      const measurement = await startHolder(f.scripts, "exclusive", f.config.path, "held");
      const waiting = spawn(process.execPath, [hostRunScript, "--lane=mac-ui", "--label=waiting", "--", "true"],
        { cwd: f.root, env: environmentFor(f.root, f.config), stdio: ["ignore", "pipe", "pipe"] });
      let waitingErr = "";
      waiting.stderr!.on("data", (chunk: Buffer) => { waitingErr += chunk.toString(); });
      const deadline = Date.now() + 10_000;
      while (!waitingErr.includes("waiting for the") && Date.now() < deadline) await Bun.sleep(20);
      waiting.kill("SIGINT");
      const waitingCode = await new Promise<number | null>((resolve) => waiting.once("exit", (code) => resolve(code)));
      expect(waitingCode, waitingErr).toBe(130);
      expect(existsSync(join(f.root, "claims.log"))).toBe(false);
      await stopHolder(measurement);

      const running = spawn(process.execPath, [hostRunScript, "--lane=mac-ui", "--label=running", "--", "sleep", "30"],
        { cwd: f.root, env: environmentFor(f.root, f.config), stdio: ["ignore", "pipe", "pipe"] });
      let runningErr = "";
      running.stderr!.on("data", (chunk: Buffer) => { runningErr += chunk.toString(); });
      const admitted = Date.now() + 10_000;
      while (!runningErr.includes("admitted") && Date.now() < admitted) await Bun.sleep(20);
      expect(lockHeld(f.scripts, f.config.path)).toBe(true);
      running.kill("SIGINT");
      await new Promise((resolve) => running.once("exit", resolve));
      expect(lockHeld(f.scripts, f.config.path)).toBe(false);
      expect(readFileSync(join(f.root, "claims.log"), "utf8")).toContain("mac-ui");
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  });
});
