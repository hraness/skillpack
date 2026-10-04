import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capabilityPlatformSupported,
  capabilityProfile,
  chromeEnvironment,
  defaultMaxHoldMilliseconds,
  describeHolders,
  holdTimeoutExitCode,
  jobEnvironment,
  parseDuration,
  queueTimeoutExitCode,
  queueTimeoutMilliseconds,
  readHolders,
  registerHolder,
  releaseHolder,
  resolveHolderRoot,
  hostAccessRequiredCode,
  hostAccessRequiredExitCode,
  inheritedLeaseCovers,
  parseHostRunArguments,
  parseInheritedLease,
  permissionBoundaryDenied,
  permitCapacity,
  permitsForMode,
  resolveAtetHostResourceModule,
  resolveAtetRuntimeRoot,
  resolveCapabilityStateRoot,
  resolveHostResourceStateRoot,
  runHostCommand,
  type HostRunOptions,
} from "./host-run";

describe("host-wide resource wrapper", () => {
  test("uses the established 1/2/all weighted model", () => {
    expect(permitCapacity(18)).toBe(4);
    expect(permitsForMode("shared", 18)).toBe(1);
    expect(permitsForMode("heavy", 18)).toBe(2);
    expect(permitsForMode("exclusive", 18)).toBe(4);
    expect(permitsForMode("exclusive", 2)).toBe(1);
  });

  test("full CPU is an explicit exclusive mac-native opt-in at every capacity", () => {
    for (const [parallelism, capacity] of [[2, 1], [3, 2], [6, 3], [12, 4]]) {
      expect(permitsForMode("exclusive", parallelism, "mac-native")).toBe(Math.min(2, capacity));
      expect(permitsForMode("exclusive", parallelism, "mac-native", true)).toBe(capacity);
      expect(permitsForMode("exclusive", parallelism, "mac-native", false)).toBe(Math.min(2, capacity));
    }
    expect(parseHostRunArguments(["--full-cpu", "--mode=exclusive", "--lane=mac-native", "--", "true"]))
      .toMatchObject({ fullCpu: true, mode: "exclusive", lane: "mac-native" });
    for (const mode of ["shared", "heavy", "exclusive"]) {
      for (const lane of ["compute", "browser", "browser-auth", "mac-native"]) {
        if (mode === "exclusive" && lane === "mac-native") continue;
        expect(() => parseHostRunArguments(["--full-cpu", `--mode=${mode}`, `--lane=${lane}`, "--", "true"]))
          .toThrow("--full-cpu requires --mode=exclusive --lane=mac-native");
      }
    }
    for (const flags of [["--full-cpu", "--full-cpu"], ["--full-cpu=true"], ["--full-cpu=false"], ["--full-cpu="], ["--full-cpu", "true"], ["--full-cpu", "false"]]) {
      expect(() => parseHostRunArguments(["--mode=exclusive", "--lane=mac-native", ...flags, "--", "true"])).toThrow();
    }
    for (const flags of [[], ["--mode=exclusive"], ["--lane=mac-native"]]) {
      expect(() => parseHostRunArguments(["--full-cpu", ...flags, "--", "true"]))
        .toThrow("--full-cpu requires");
    }
    expect(() => parseHostRunArguments(["--full-cpu", "--mode=exclusive", "--lane=mac-native", "--"]))
      .toThrow("requires a command");
    expect(parseHostRunArguments(["--", "true", "--full-cpu"]))
      .toEqual({ command: ["true", "--full-cpu"], label: "true", lane: "compute", mode: "shared" });
  });

  test("full CPU API validation precedes runtime access", async () => {
    for (const fullCpu of ["true", 1, null, {}, true]) {
      await expect(runHostCommand({
        command: ["true"], cwd: "/missing", label: "invalid", lane: "compute", mode: "shared",
        fullCpu,
        environment: { ATET_HOST_RESOURCES_MODULE: "/missing" },
      } as unknown as HostRunOptions)).rejects.toThrow("full-cpu");
    }
    for (const mode of ["shared", "heavy", "exclusive"] as const) {
      for (const lane of ["compute", "browser", "browser-auth", "mac-native"] as const) {
        if (mode === "exclusive" && lane === "mac-native") continue;
        await expect(runHostCommand({ command: ["true"], cwd: "/missing", label: "invalid", lane, mode, fullCpu: true, environment: {} }))
          .rejects.toThrow("--full-cpu requires");
      }
    }
  });

  test("nested full CPU requires truthful full-capacity native ownership", () => {
    for (const permits of [2, 4]) {
      const inherited = parseInheritedLease(JSON.stringify({
        capacity: 4, label: "native", lane: "mac-native", mode: "exclusive", permits, version: 2,
      }));
      expect(inheritedLeaseCovers(inherited, { lane: "mac-native", mode: "exclusive", fullCpu: true })).toBe(permits === 4);
      expect(inheritedLeaseCovers(inherited, { lane: "mac-native", mode: "exclusive" })).toBe(true);
      expect(inheritedLeaseCovers(inherited, { lane: "compute", mode: "exclusive" })).toBe(permits === 4);
      expect(inheritedLeaseCovers(inherited, { lane: "browser", mode: "shared" })).toBe(false);
    }
  });

  test("parses argv without invoking a shell", () => {
    expect(parseHostRunArguments([
      "--mode=heavy",
      "--label=repo-check",
      "--",
      "bun",
      "run",
      "check",
    ])).toEqual({
      command: ["bun", "run", "check"],
      label: "repo-check",
      lane: "compute",
      mode: "heavy",
    });
  });

  test("rejects malformed modes and missing command delimiters", () => {
    expect(() => parseHostRunArguments(["--mode=wide", "--", "true"]))
      .toThrow("invalid resource mode");
    expect(() => parseHostRunArguments(["true"]))
      .toThrow("requires --");
    expect(() => parseHostRunArguments(["--label=contains spaces", "--", "true"]))
      .toThrow("ASCII identifier");
    expect(() => parseHostRunArguments(["--lane=cloud", "--", "true"]))
      .toThrow("invalid capability lane");
  });

  test("parses capability lanes independently from compute weight", () => {
    expect(parseHostRunArguments([
      "--mode=exclusive",
      "--lane=browser-auth",
      "--label=browser-test",
      "--",
      "true",
    ])).toEqual({
      command: ["true"],
      label: "browser-test",
      lane: "browser-auth",
      mode: "exclusive",
    });
  });

  test("uses one machine-wide state root across isolated Codex profiles", () => {
    const first = resolveHostResourceStateRoot(
      { CODEX_HOME: "/profiles/one" },
      "/opt/tester",
    );
    const second = resolveHostResourceStateRoot(
      { CODEX_HOME: "/profiles/two" },
      "/opt/tester",
    );
    expect(first).toBe("/opt/tester/.local/state/local-efficiency/host-resources-v1");
    expect(second).toBe(first);
    expect(resolveCapabilityStateRoot(first))
      .toBe("/opt/tester/.local/state/local-efficiency/capabilities-v2");
    expect(resolveHostResourceStateRoot(
      { CODEX_HOME: "/profiles/three", XDG_STATE_HOME: "/state" },
      "/opt/tester",
    )).toBe("/state/local-efficiency/host-resources-v1");
    expect(resolveAtetRuntimeRoot(
      { CODEX_HOME: "/profiles/one" },
      "/opt/tester",
    )).toBe("/opt/tester/.local/share/local-efficiency/runtime/atet-v2.0.0");
    expect(resolveAtetRuntimeRoot(
      { CODEX_HOME: "/profiles/two" },
      "/opt/tester",
    )).toBe(resolveAtetRuntimeRoot({}, "/opt/tester"));
  });

  test("requires macOS for the mac-native lane", () => {
    expect(capabilityPlatformSupported("mac-native", "darwin")).toBe(true);
    expect(capabilityPlatformSupported("mac-native", "linux")).toBe(false);
    expect(capabilityPlatformSupported("browser-auth", "linux")).toBe(true);
  });

  test("validates inherited lease metadata and rejects mode or capability escalation", () => {
    expect(inheritedLeaseCovers(parseInheritedLease(JSON.stringify({
      capacity: 4,
      label: "legacy",
      mode: "exclusive",
      permits: 4,
      version: 1,
    })), {
      lane: "compute",
      mode: "exclusive",
    })).toBe(true);
    const sharedBrowser = parseInheritedLease(JSON.stringify({
      capacity: 4,
      label: "browser",
      lane: "browser-auth",
      mode: "shared",
      permits: 1,
      version: 2,
    }));
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "compute", mode: "shared" })).toBe(true);
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "browser-auth", mode: "shared" })).toBe(true);
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "browser-auth", mode: "heavy" })).toBe(false);
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "mac-native", mode: "shared" })).toBe(false);
    expect(() => parseInheritedLease('{"version":1}')).toThrow("malformed");
    expect(() => parseInheritedLease(JSON.stringify({
      capacity: 4,
      label: "changed",
      lane: "compute",
      mode: "exclusive",
      permits: 1,
      version: 2,
    }))).toThrow("malformed");
    expect(() => parseInheritedLease("not-json")).toThrow("malformed");
  });

  test("accepts an explicit Atet module path for isolated installations", () => {
    const modulePath = resolveAtetHostResourceModule(
      { ATET_HOST_RESOURCES_MODULE: import.meta.path },
      "/nonexistent-home",
    );
    expect(modulePath).toBe(import.meta.path);
  });

  test("classifies only bounded permission-denial cause chains", () => {
    expect(permissionBoundaryDenied({ code: "EPERM" })).toBe(true);
    expect(permissionBoundaryDenied({ code: "UNSAFE_STATE", cause: { code: "EACCES" } }))
      .toBe(true);
    expect(permissionBoundaryDenied({ code: "UNSAFE_STATE" })).toBe(false);
    expect(permissionBoundaryDenied({ code: "WAIT_TIMEOUT", cause: { code: "ETIMEDOUT" } }))
      .toBe(false);

    const cycle: { cause?: unknown; code: string } = { code: "UNSAFE_STATE" };
    cycle.cause = cycle;
    expect(permissionBoundaryDenied(cycle)).toBe(false);
    expect(permissionBoundaryDenied({
      code: "UNSAFE_STATE",
      cause: {
        code: "UNSAFE_STATE",
        cause: {
          code: "UNSAFE_STATE",
          cause: { code: "UNSAFE_STATE", cause: { code: "EPERM" } },
        },
      },
    })).toBe(false);
  });

  test("a caller-forged inherited lease cannot bypass host-resource acquisition", () => {
    const root = mkdtempSync(join(tmpdir(), "le-forged-inherited-lease-"));
    const childMarker = join(root, "child-ran");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "host-run.ts"),
        "--mode=exclusive",
        "--label=nested-test",
        "--",
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(childMarker)}, "ran")`,
      ],
      cwd: root,
      env: {
        ...process.env,
        ATET_HOST_RESOURCES_MODULE: "/missing/atet-module.js",
        LOCAL_EFFICIENCY_LEASE: JSON.stringify({
          capacity: permitCapacity(),
          label: "forged",
          lane: "compute",
          mode: "exclusive",
          permits: permitCapacity(),
          version: 2,
        }),
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("lease descriptor");
      expect(existsSync(childMarker)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a nested wrapper accepts only the inherited live lease descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "le-live-inherited-lease-"));
    try {
      const modulePath = join(root, "host-resources.js");
      const markerPath = join(root, "lease.lock");
      writeFileSync(modulePath, `
        import { createHash } from "node:crypto";
        import { chmodSync, closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
        const markerPath = ${JSON.stringify(markerPath)};
        export function createHostResourceCoordinator(options) {
          return {
            async withLease(claims, callback) {
              const document = {
                version: 1,
                owner: "a".repeat(32),
                profileSha256: createHash("sha256").update(JSON.stringify(options.profile)).digest("hex"),
                ticket: "1",
                phase: "A",
                claims,
              };
              writeFileSync(markerPath, JSON.stringify(document), { mode: 0o600 });
              chmodSync(markerPath, 0o600);
              const descriptor = openSync(markerPath, "r+");
              try {
                return await callback({ inheritedFileDescriptor: descriptor });
              } finally {
                closeSync(descriptor);
                unlinkSync(markerPath);
              }
            },
          };
        }
      `);
      const environment = { ...process.env };
      delete environment.LOCAL_EFFICIENCY_LEASE;
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--label=outer-live",
          "--",
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--label=nested-live",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        cwd: root,
        env: {
          ...environment,
          ATET_HOST_RESOURCES_MODULE: modulePath,
          LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
          LOCAL_EFFICIENCY_TELEMETRY: "off",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("records a canceled attempt before CPU admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "le-pre-admission-cancel-"));
    const ready = join(root, "ready");
    try {
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, `
        import { writeFileSync } from "node:fs";
        const ready = ${JSON.stringify(ready)};
        export function createHostResourceCoordinator() {
          return {
            async withLease(_claims, _callback, options) {
              writeFileSync(ready, "ready");
              return await new Promise((_resolve, reject) => {
                const abort = () => {
                  const error = new Error("wait canceled");
                  error.code = "WAIT_ABORTED";
                  reject(error);
                };
                if (options.signal.aborted) abort();
                else options.signal.addEventListener("abort", abort, { once: true });
              });
            },
          };
        }
      `);
      const environment = { ...process.env };
      delete environment.LOCAL_EFFICIENCY_LEASE;
      const wrapper = Bun.spawn({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=exclusive",
          "--label=cancel-before-admission",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        cwd: root,
        env: {
          ...environment,
          ATET_HOST_RESOURCES_MODULE: modulePath,
          LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);
      wrapper.kill("SIGTERM");
      expect(await wrapper.exited).toBe(143);
      const telemetryRoot = join(root, "state", "telemetry-v1");
      const files = readdirSync(telemetryRoot);
      expect(files).toHaveLength(1);
      const lines = readFileSync(join(telemetryRoot, files[0] ?? ""), "utf8")
        .trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        admittedAt: null,
        exitCode: 143,
        outcome: "canceled",
        runMilliseconds: null,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("acquires the scarce browser capability before weighted CPU permits", () => {
    const root = mkdtempSync(join(tmpdir(), "le-browser-capability-order-"));
    try {
      const log = join(root, "order.log");
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, `
        import { appendFileSync, closeSync, openSync } from "node:fs";
        const log = ${JSON.stringify(log)};
        export function createHostResourceCoordinator(options) {
          const id = options.profile.id.includes("capabilities") ? "capability" : "cpu";
          return {
            async withLease(_claims, callback) {
              appendFileSync(log, id + ":start\\n");
              const descriptor = openSync("/dev/null", "r");
              try {
                return await callback({ inheritedFileDescriptor: descriptor });
              } finally {
                closeSync(descriptor);
                appendFileSync(log, id + ":end\\n");
              }
            },
          };
        }
      `);
      const environment = { ...process.env };
      delete environment.LOCAL_EFFICIENCY_LEASE;
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--lane=browser-auth",
          "--label=browser-order",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        cwd: root,
        env: {
          ...environment,
          ATET_HOST_RESOURCES_MODULE: modulePath,
          LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
          LOCAL_EFFICIENCY_TELEMETRY: "off",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "capability:start",
        "cpu:start",
        "cpu:end",
        "capability:end",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("forwards interruption to the complete child process group", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "le-process-group-custody-"));
    const modulePath = join(root, "host-resources.js");
    const ready = join(root, "ready");
    const orphanMarker = join(root, "orphan-ran");
    writeFileSync(modulePath, `
      import { closeSync, openSync } from "node:fs";
      export function createHostResourceCoordinator() {
        return {
          async withLease(_claims, callback) {
            const descriptor = openSync("/dev/null", "r");
            try {
              return await callback({ inheritedFileDescriptor: descriptor });
            } finally {
              closeSync(descriptor);
            }
          },
        };
      }
    `);
    const leaderSource = `
      Bun.spawn({
        cmd: [process.execPath, "-e", ${JSON.stringify(`await Bun.sleep(800); await Bun.write(${JSON.stringify(orphanMarker)}, "ran")`)}],
        stderr: "ignore",
        stdout: "ignore",
      });
      await Bun.write(${JSON.stringify(ready)}, "ready");
      await Bun.sleep(10_000);
    `;
    const environment = { ...process.env };
    delete environment.LOCAL_EFFICIENCY_LEASE;
    const wrapper = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "host-run.ts"),
        "--mode=shared",
        "--label=process-group",
        "--",
        process.execPath,
        "-e",
        leaderSource,
      ],
      cwd: root,
      env: {
        ...environment,
        ATET_HOST_RESOURCES_MODULE: modulePath,
        LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
        LOCAL_EFFICIENCY_TELEMETRY: "off",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);
      wrapper.kill("SIGTERM");
      await wrapper.exited;
      await Bun.sleep(1_000);
      expect(existsSync(orphanMarker)).toBe(false);
    } finally {
      wrapper.kill("SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("force-cleans a residual descendant after its command leader exits", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "le-residual-process-group-"));
    const modulePath = join(root, "host-resources.js");
    const ready = join(root, "ready");
    const residualMarker = join(root, "residual-ran");
    writeFileSync(modulePath, `
      import { closeSync, openSync } from "node:fs";
      export function createHostResourceCoordinator() {
        return {
          async withLease(_claims, callback) {
            const descriptor = openSync("/dev/null", "r");
            try {
              return await callback({ inheritedFileDescriptor: descriptor });
            } finally {
              closeSync(descriptor);
            }
          },
        };
      }
    `);
    const descendantSource = `
      process.on("SIGTERM", () => {});
      await Bun.sleep(800);
      await Bun.write(${JSON.stringify(residualMarker)}, "ran");
    `;
    const leaderSource = `
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
        stdio: "ignore",
      });
      child.unref();
      await Bun.write(${JSON.stringify(ready)}, "ready");
    `;
    const environment = { ...process.env };
    delete environment.LOCAL_EFFICIENCY_LEASE;
    const wrapper = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "host-run.ts"),
        "--mode=shared",
        "--label=residual-process-group",
        "--",
        process.execPath,
        "-e",
        leaderSource,
      ],
      cwd: root,
      env: {
        ...environment,
        ATET_HOST_RESOURCES_MODULE: modulePath,
        LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
        LOCAL_EFFICIENCY_TELEMETRY: "off",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);
      expect(await wrapper.exited).toBe(0);
      await Bun.sleep(1_000);
      expect(existsSync(residualMarker)).toBe(false);
    } finally {
      wrapper.kill("SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reports a stable reviewed-host-access boundary before child execution", () => {
    const root = mkdtempSync(join(tmpdir(), "le-host-access-boundary-"));
    try {
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, `
        export function createHostResourceCoordinator() {
          return {
            async withLease() {
              const cause = new Error("private scheduler path");
              cause.code = "EPERM";
              const error = new Error("unsafe state", { cause });
              error.code = "UNSAFE_STATE";
              throw error;
            },
          };
        }
      `);
      const childMarker = join(root, "child-ran");
      const environment = { ...process.env };
      delete environment.LOCAL_EFFICIENCY_LEASE;
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--label=boundary-test",
          "--",
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(childMarker)}, "ran")`,
        ],
        cwd: root,
        env: {
          ...environment,
          ATET_HOST_RESOURCES_MODULE: modulePath,
          LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state"),
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode).toBe(hostAccessRequiredExitCode);
      expect(result.stderr.toString()).toContain(hostAccessRequiredCode);
      expect(result.stderr.toString()).toContain("identical host-run invocation");
      expect(result.stderr.toString()).not.toContain("private scheduler path");
      expect(existsSync(childMarker)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("caps exclusive on capability lanes at two CPU permits", () => {
    expect(permitsForMode("exclusive", 16, "compute")).toBe(4);
    expect(permitsForMode("exclusive", 16, "browser")).toBe(2);
    expect(permitsForMode("exclusive", 16, "browser-auth")).toBe(2);
    expect(permitsForMode("exclusive", 16, "mac-native")).toBe(2);
    expect(permitsForMode("heavy", 16, "browser")).toBe(2);
    expect(permitsForMode("shared", 16, "browser")).toBe(1);
    expect(permitsForMode("exclusive", 2, "browser")).toBe(1);
  });

  test("defines capabilities-v2 with a four-slot headless browser lane", () => {
    expect(capabilityProfile.id).toBe("local-efficiency/capabilities-v2");
    expect(capabilityProfile.capacities).toEqual([
      { resource: "browser", limit: 4 },
      { resource: "browser-auth", limit: 1 },
      { resource: "mac-native", limit: 1 },
    ]);
    expect(parseHostRunArguments(["--lane=browser", "--", "true"])).toEqual({
      command: ["true"],
      label: "true",
      lane: "browser",
      mode: "shared",
    });
  });

  test("parses --max-hold durations and lane defaults", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("20m")).toBe(1_200_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("45")).toBe(2_700_000);
    expect(parseDuration("none")).toBeNull();
    expect(() => parseDuration("soon")).toThrow("invalid duration");
    expect(() => parseDuration("0")).toThrow("invalid duration");
    expect(parseHostRunArguments(["--max-hold=none", "--", "true"]).maxHoldMilliseconds).toBeNull();
    expect(parseHostRunArguments(["--max-hold=2h", "--", "true"]).maxHoldMilliseconds)
      .toBe(7_200_000);
    expect(parseHostRunArguments(["--", "true"])).not.toHaveProperty("maxHoldMilliseconds");
    expect(() => parseHostRunArguments(["--max-hold=1m", "--max-hold=2m", "--", "true"]))
      .toThrow("only once");
    expect(defaultMaxHoldMilliseconds("compute", "exclusive")).toBe(60 * 60_000);
    expect(defaultMaxHoldMilliseconds("browser", "shared")).toBe(20 * 60_000);
    expect(defaultMaxHoldMilliseconds("browser-auth", "heavy")).toBe(45 * 60_000);
    expect(defaultMaxHoldMilliseconds("browser-auth", "exclusive")).toBe(45 * 60_000);
    expect(defaultMaxHoldMilliseconds("compute", "heavy")).toBeNull();
    expect(defaultMaxHoldMilliseconds("mac-native", "shared")).toBeNull();
    expect(queueTimeoutMilliseconds).toBe(2 * 60 * 60_000);
  });

  test("derives job widths from permits and never overrides the caller", () => {
    expect(jobEnvironment(1, 4, { PATH: "" }, 16)).toEqual({
      CARGO_BUILD_JOBS: "4",
      HRA_JOBS: "4",
      MAKEFLAGS: "-j4",
      NEXTEST_TEST_THREADS: "4",
      RAYON_NUM_THREADS: "4",
    });
    expect(jobEnvironment(2, 4, { PATH: "" }, 16).HRA_JOBS).toBe("8");
    expect(jobEnvironment(4, 4, { PATH: "" }, 16).CARGO_BUILD_JOBS).toBe("16");
    expect(jobEnvironment(1, 4, { PATH: "" }, 2).HRA_JOBS).toBe("1");
    const preset = jobEnvironment(2, 4, { CARGO_BUILD_JOBS: "3", MAKEFLAGS: "-j2", PATH: "" }, 16);
    expect(preset).not.toHaveProperty("CARGO_BUILD_JOBS");
    expect(preset).not.toHaveProperty("MAKEFLAGS");
    expect(preset.RAYON_NUM_THREADS).toBe("8");
  });

  test("uses sccache as RUSTC_WRAPPER only when it is already on PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "le-sccache-path-"));
    try {
      expect(jobEnvironment(1, 4, { PATH: root }, 16)).not.toHaveProperty("RUSTC_WRAPPER");
      const sccache = join(root, "sccache");
      writeFileSync(sccache, "#!/bin/sh\n");
      chmodSync(sccache, 0o755);
      expect(jobEnvironment(1, 4, { PATH: `/nonexistent:${root}` }, 16).RUSTC_WRAPPER)
        .toBe("sccache");
      expect(jobEnvironment(1, 4, { PATH: root, RUSTC_WRAPPER: "custom" }, 16))
        .not.toHaveProperty("RUSTC_WRAPPER");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("routes agent-browser through hra-chrome and retains explicit browser selection", () => {
    const launcher = join(import.meta.dir, "hra-chrome");
    expect(chromeEnvironment({}, "darwin", launcher)).toEqual({
      AGENT_BROWSER_EXECUTABLE_PATH: launcher,
      HRA_CHROME: launcher,
    });
    expect(chromeEnvironment({ AGENT_BROWSER_EXECUTABLE_PATH: process.execPath }, "darwin", launcher))
      .toEqual({
        AGENT_BROWSER_EXECUTABLE_PATH: launcher,
        HRA_CHROME: launcher,
        HRA_CHROME_REAL: realpathSync(process.execPath),
      });
    const inherited = { HRA_CHROME: launcher, AGENT_BROWSER_EXECUTABLE_PATH: launcher, HRA_CHROME_REAL: process.execPath };
    expect(chromeEnvironment(inherited, "darwin", launcher)).toEqual({});
    expect(chromeEnvironment({ HRA_CHROME: process.execPath }, "darwin", launcher))
      .toEqual({ AGENT_BROWSER_EXECUTABLE_PATH: launcher });
    expect(() => chromeEnvironment({
      AGENT_BROWSER_EXECUTABLE_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    }, "darwin", launcher)).toThrow("refusing system Google Chrome");
    expect(chromeEnvironment({}, "linux", launcher)).toEqual({});
    expect(() => chromeEnvironment({}, "darwin", "/missing/hra-chrome")).toThrow("hra-chrome launcher unavailable");
  });

  test("accepts browser leases and rejects capability-lane escalation to all permits", () => {
    const browserExclusive = parseInheritedLease(JSON.stringify({
      capacity: 4, label: "headless", lane: "browser", mode: "exclusive", permits: 2, version: 2,
    }));
    expect(browserExclusive.lane).toBe("browser");
    expect(inheritedLeaseCovers(browserExclusive, { lane: "browser", mode: "exclusive" })).toBe(true);
    expect(inheritedLeaseCovers(browserExclusive, { lane: "compute", mode: "heavy" })).toBe(true);
    expect(inheritedLeaseCovers(browserExclusive, { lane: "compute", mode: "exclusive" })).toBe(false);
    expect(inheritedLeaseCovers(browserExclusive, { lane: "browser-auth", mode: "shared" })).toBe(false);
    const auth = parseInheritedLease(JSON.stringify({
      capacity: 4, label: "signed-in", lane: "browser-auth", mode: "shared", permits: 1, version: 2,
    }));
    expect(inheritedLeaseCovers(auth, { lane: "browser", mode: "shared" })).toBe(true);
    expect(() => parseInheritedLease(JSON.stringify({
      capacity: 4, label: "forged", lane: "browser", mode: "exclusive", permits: 4, version: 2,
    }))).toThrow("malformed");
    const legacy = parseInheritedLease(JSON.stringify({
      capacity: 4, label: "legacy", lane: "browser-auth", mode: "exclusive", permits: 4, version: 2,
    }));
    expect(inheritedLeaseCovers(legacy, { lane: "compute", mode: "exclusive" })).toBe(true);
  });

  test("describes live holders and ignores dead ones", () => {
    const root = mkdtempSync(join(tmpdir(), "le-holders-"));
    try {
      const now = new Date("2026-09-29T05:00:00.000Z");
      const live = registerHolder(root, {
        admittedAt: "2026-09-29T01:00:00.000Z",
        label: "static-preview",
        lane: "browser-auth",
        mode: "shared",
        permits: 1,
        pid: 4242,
        version: 1,
      }, "aaaaaaaaaaaaaaaa");
      registerHolder(root, {
        admittedAt: "2026-09-29T04:00:00.000Z",
        label: "dead-run",
        lane: "compute",
        mode: "heavy",
        permits: 2,
        pid: 4343,
        version: 1,
      }, "bbbbbbbbbbbbbbbb");
      const holders = readHolders(root, (pid) => pid === 4242);
      expect(holders.map((holder) => holder.label)).toEqual(["static-preview"]);
      expect(describeHolders(holders, "browser-auth", now))
        .toBe("held by static-preview (pid 4242, shared browser-auth, 1 permits, held 4h00m)");
      expect(describeHolders([], "browser", now)).toContain("unregistered holder");
      releaseHolder(live);
      expect(readHolders(root, () => true).map((holder) => holder.label)).toEqual(["dead-run"]);
      expect(resolveHolderRoot("/state/local-efficiency/host-resources-v1"))
        .toBe("/state/local-efficiency/holders-v1");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  const passThroughModule = (root: string, log?: string): string => {
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, `
      import { appendFileSync, closeSync, openSync } from "node:fs";
      const log = ${JSON.stringify(log ?? null)};
      export function createHostResourceCoordinator(options) {
        return {
          async withLease(claims, callback, leaseOptions) {
            if (log !== null) appendFileSync(log, JSON.stringify({
              profile: options.profile, stateRoot: options.stateRoot, claims,
              wait: leaseOptions.waitTimeoutMilliseconds,
            }) + "\\n");
            const descriptor = openSync("/dev/null", "r");
            try {
              return await callback({ inheritedFileDescriptor: descriptor });
            } finally {
              closeSync(descriptor);
            }
          },
        };
      }
    `);
    return modulePath;
  };

  const cleanEnvironment = (): NodeJS.ProcessEnv => {
    const environment = { ...process.env };
    for (const key of [
      "LOCAL_EFFICIENCY_LEASE", "CARGO_BUILD_JOBS", "HRA_JOBS", "MAKEFLAGS",
      "NEXTEST_TEST_THREADS", "RAYON_NUM_THREADS", "AGENT_BROWSER_EXECUTABLE_PATH", "HRA_CHROME",
      "HRA_CHROME_REAL", "AGENT_BROWSER_CONFIG",
    ]) delete environment[key];
    return environment;
  };

  test("full CPU native admission holds both real fixture claims before child and validates nested descriptors", () => {
    if (process.platform !== "darwin") return;
    const root = mkdtempSync(join(tmpdir(), "le-full-cpu-native-"));
    try {
      const modulePath = join(root, "host-resources.js");
      const log = join(root, "claims.log");
      const childMarker = join(root, "child-ran");
      writeFileSync(modulePath, `
        import { createHash } from "node:crypto";
        import { appendFileSync, closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
        export function createHostResourceCoordinator(options) {
          return { async withLease(claims, callback) {
            const resource = claims[0].resource;
            const path = ${JSON.stringify(root)} + "/" + resource + ".lock";
            appendFileSync(${JSON.stringify(log)}, JSON.stringify({ profile: options.profile, stateRoot: options.stateRoot, claims }) + "\\n");
            writeFileSync(path, JSON.stringify({
              version: 1, owner: "a".repeat(32), ticket: "1", phase: "A", claims,
              profileSha256: createHash("sha256").update(JSON.stringify(options.profile)).digest("hex"),
            }), { mode: 0o600 });
            const descriptor = openSync(path, "r+");
            try { return await callback({ inheritedFileDescriptor: descriptor }); }
            finally { closeSync(descriptor); unlinkSync(path); }
          } };
        }
      `);
      for (const fullCpu of [false, true]) {
        writeFileSync(log, "");
        const childScript = `
          import { existsSync, readFileSync } from "node:fs";
          const root = ${JSON.stringify(root)};
          if (!existsSync(root + "/mac-native.lock") || !existsSync(root + "/cpu.lock")) process.exit(20);
          const entries = readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").map(JSON.parse);
          if (entries.length !== 2 || entries[0].claims[0].resource !== "mac-native" || entries[1].claims[0].amount !== ${fullCpu ? permitCapacity() : Math.min(2, permitCapacity())}) process.exit(21);
          await Bun.write(${JSON.stringify(childMarker)}, "ran");
        `;
        const result = Bun.spawnSync({
          cmd: [process.execPath, join(import.meta.dir, "host-run.ts"), "--mode=exclusive", "--lane=mac-native",
            ...(fullCpu ? ["--full-cpu"] : []), "--", process.execPath, "-e", childScript],
          cwd: root,
          env: { ...cleanEnvironment(), ATET_HOST_RESOURCES_MODULE: modulePath,
            LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"), LOCAL_EFFICIENCY_TELEMETRY: "off" },
          stderr: "pipe", stdout: "pipe",
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(existsSync(childMarker)).toBe(true);
        expect(existsSync(join(root, "cpu.lock"))).toBe(false);
        expect(existsSync(join(root, "mac-native.lock"))).toBe(false);
        const entries = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(entries[0].profile).toEqual(capabilityProfile);
        expect(entries[0].claims).toEqual([{ resource: "mac-native", amount: 1 }]);
        expect(entries[1].profile).toEqual({ id: `local-efficiency/v1-${permitCapacity()}`, capacities: [{ resource: "cpu", limit: permitCapacity() }] });
        expect(entries[1].claims).toEqual([{ resource: "cpu", amount: fullCpu ? permitCapacity() : Math.min(2, permitCapacity()) }]);
        rmSync(childMarker);
      }
      for (const { fullCpu, forged } of [{ fullCpu: false, forged: false }, { fullCpu: true, forged: false }, { fullCpu: true, forged: true }]) {
        const covered = fullCpu || permitCapacity() <= 2;
        const script = `
          import { readFileSync, writeFileSync } from "node:fs";
          if (${forged}) {
            const path = ${JSON.stringify(join(root, "cpu.lock"))};
            const marker = JSON.parse(readFileSync(path, "utf8"));
            marker.claims[0].amount = 0;
            writeFileSync(path, JSON.stringify(marker));
          }
          const { runHostCommand } = await import(${JSON.stringify(join(import.meta.dir, "host-run.ts"))});
          for (const request of [{ lane: "mac-native", mode: "exclusive", fullCpu: true }, { lane: "mac-native", mode: "exclusive" }, { lane: "compute", mode: "exclusive" }]) {
            await runHostCommand({ ...request, command: [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(`await Bun.write(${JSON.stringify(childMarker)}, "ran")`)}], cwd: ${JSON.stringify(root)}, label: "nested" });
          }
        `;
        const result = Bun.spawnSync({
          cmd: [process.execPath, join(import.meta.dir, "host-run.ts"), "--mode=exclusive", "--lane=mac-native", ...(fullCpu ? ["--full-cpu"] : []), "--", process.execPath, "-e", script],
          cwd: root,
          env: { ...cleanEnvironment(), ATET_HOST_RESOURCES_MODULE: modulePath,
            LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"), LOCAL_EFFICIENCY_TELEMETRY: "off" },
          stderr: "pipe", stdout: "pipe",
        });
        expect(result.exitCode === 0, result.stderr.toString()).toBe(covered && !forged);
        expect(existsSync(childMarker)).toBe(covered && !forged);
        if (forged) expect(result.stderr.toString()).toContain("lease descriptor does not cover");
        if (!covered) expect(result.stderr.toString()).toContain("nested host-run cannot escalate");
        if (covered && !forged) rmSync(childMarker);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("claims the browser lane from capabilities-v2 with capped permits and a 2h queue bound", () => {
    const root = mkdtempSync(join(tmpdir(), "le-browser-lane-"));
    try {
      const log = join(root, "claims.log");
      const envFile = join(root, "env.json");
      const result = Bun.spawnSync({
        cmd: [
          process.execPath, join(import.meta.dir, "host-run.ts"),
          "--mode=exclusive", "--lane=browser", "--label=headless-suite", "--",
          process.execPath, "-e",
          `await Bun.write(${JSON.stringify(envFile)}, JSON.stringify(process.env))`,
        ],
        cwd: root,
        env: {
          ...cleanEnvironment(),
          ATET_HOST_RESOURCES_MODULE: passThroughModule(root, log),
          LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
          LOCAL_EFFICIENCY_TELEMETRY: "off",
          MAKEFLAGS: "-j1",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).toContain("max hold 20m00s");
      const entries = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(entries[0].profile.id).toBe("local-efficiency/capabilities-v2");
      expect(entries[0].stateRoot).toBe(join(root, "state", "capabilities-v2"));
      expect(entries[0].claims).toEqual([{ resource: "browser", amount: 1 }]);
      expect(entries[1].claims).toEqual([{ resource: "cpu", amount: Math.min(2, permitCapacity()) }]);
      for (const entry of entries) expect(entry.wait).toBeLessThanOrEqual(2 * 60 * 60_000);
      const childEnvironment = JSON.parse(readFileSync(envFile, "utf8"));
      expect(Number(childEnvironment.HRA_JOBS)).toBeGreaterThanOrEqual(1);
      expect(childEnvironment.CARGO_BUILD_JOBS).toBe(childEnvironment.HRA_JOBS);
      expect(childEnvironment.NEXTEST_TEST_THREADS).toBe(childEnvironment.HRA_JOBS);
      expect(childEnvironment.RAYON_NUM_THREADS).toBe(childEnvironment.HRA_JOBS);
      expect(childEnvironment.MAKEFLAGS).toBe("-j1");
      expect(JSON.parse(childEnvironment.LOCAL_EFFICIENCY_LEASE)).toMatchObject({
        lane: "browser", mode: "exclusive", permits: Math.min(2, permitCapacity()),
      });
      if (process.platform === "darwin") {
        expect(childEnvironment.AGENT_BROWSER_EXECUTABLE_PATH)
          .toBe(join(import.meta.dir, "hra-chrome"));
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("terminates a lease that exceeds its max hold and records hold-timeout", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "le-max-hold-"));
    try {
      const survivor = join(root, "survived");
      const started = performance.now();
      const result = Bun.spawnSync({
        cmd: [
          process.execPath, join(import.meta.dir, "host-run.ts"),
          "--mode=shared", "--label=stuck-server", "--max-hold=600ms", "--",
          process.execPath, "-e",
          `process.on("SIGTERM", () => {}); await Bun.sleep(5_000); await Bun.write(${JSON.stringify(survivor)}, "x")`,
        ],
        cwd: root,
        env: {
          ...cleanEnvironment(),
          ATET_HOST_RESOURCES_MODULE: passThroughModule(root),
          LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      const elapsed = performance.now() - started;
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr).toBe(holdTimeoutExitCode);
      expect(elapsed).toBeLessThan(4_500);
      expect(stderr).toContain("used 80% of its");
      expect(stderr).toContain("sending TERM");
      expect(stderr).toContain("sending KILL");
      expect(existsSync(survivor)).toBe(false);
      const telemetryRoot = join(root, "state", "telemetry-v1");
      const files = readdirSync(telemetryRoot);
      const event = JSON.parse(readFileSync(join(telemetryRoot, files[0] ?? ""), "utf8").trim());
      expect(event).toMatchObject({ exitCode: holdTimeoutExitCode, outcome: "hold-timeout" });
      expect(readdirSync(join(root, "state", "holders-v1"))).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("prints the holder while waiting and exits 75 on queue timeout", () => {
    const root = mkdtempSync(join(tmpdir(), "le-queue-timeout-"));
    try {
      const holders = join(root, "state", "holders-v1");
      mkdirSync(holders, { recursive: true });
      registerHolder(holders, {
        admittedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        label: "algal-marketing-preview",
        lane: "browser-auth",
        mode: "shared",
        permits: 1,
        pid: process.pid,
        version: 1,
      }, "cccccccccccccccc");
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, `
        export function createHostResourceCoordinator() {
          return {
            async withLease() {
              await new Promise((resolve) => setTimeout(resolve, 400));
              const error = new Error("Host-resource admission exceeded its bounded wait.");
              error.code = "WAIT_TIMEOUT";
              throw error;
            },
          };
        }
      `);
      const result = Bun.spawnSync({
        cmd: [
          process.execPath, join(import.meta.dir, "host-run.ts"),
          "--mode=heavy", "--lane=browser-auth", "--label=blocked-check", "--",
          process.execPath, "-e", "process.exit(0)",
        ],
        cwd: root,
        env: {
          ...cleanEnvironment(),
          ATET_HOST_RESOURCES_MODULE: modulePath,
          LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
          LOCAL_EFFICIENCY_TELEMETRY: "off",
          LOCAL_EFFICIENCY_WAIT_REPORT_MS: "50",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr).toBe(queueTimeoutExitCode);
      expect(stderr).toContain("still waiting");
      expect(stderr).toContain(`algal-marketing-preview (pid ${process.pid}, shared browser-auth`);
      expect(stderr).toContain("held 3h00m");
      expect(stderr).toContain("QUEUE_TIMEOUT");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
