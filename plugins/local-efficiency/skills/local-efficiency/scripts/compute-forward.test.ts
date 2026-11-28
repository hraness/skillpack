import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCleanSubmodules, forwardedEnvironment } from "./compute-forward";
import { forwardsHold } from "./host-run";
import { type ForwardDependencies, ForwardUnavailableError } from "./mac-ui-forward";

describe("compute forwarding environment", () => {
  test("sends only allowlisted build settings, never secrets or local paths", () => {
    const { assignments, kept } = forwardedEnvironment({
      AWS_SECRET_ACCESS_KEY: "x",
      CARGO_BUILD_JOBS: "8",
      CARGO_HOME: "/opt/cargo",
      CARGO_INCREMENTAL: "0",
      CARGO_REGISTRIES_PRIVATE_TOKEN: "t",
      CARGO_REGISTRY_TOKEN: "t",
      CARGO_TARGET_DIR: "~/target",
      CI: "1",
      GITHUB_TOKEN: "t",
      HOME: "/opt/home",
      HRA_JOBS: "4",
      NPM_TOKEN: "t",
      OPENAI_API_KEY: "t",
      PATH: "/usr/bin",
      RUSTFLAGS: "-C target-cpu=native",
      RUST_LOG: "debug\nnewline",
      SSH_AUTH_SOCK: "/tmp/agent",
      WEIRD: "/opt/home/x",
    }, "/opt/home");
    expect(assignments).toEqual(["CARGO_BUILD_JOBS=8", "CARGO_INCREMENTAL=0", "CI=1", "HRA_JOBS=4", "RUSTFLAGS=-C target-cpu=native"]);
    expect(kept).toEqual(["CARGO_HOME", "CARGO_REGISTRIES_PRIVATE_TOKEN", "CARGO_REGISTRY_TOKEN", "CARGO_TARGET_DIR", "RUST_LOG"]);
  });

  test("a value that names this Mac's home directory stays here", () => {
    expect(forwardedEnvironment({ RUSTFLAGS: "--remap-path-prefix=/opt/me/src=." }, "/opt/me").kept).toEqual(["RUSTFLAGS"]);
  });
});

describe("compute forwarding submodules", () => {
  const deps = (status: string, porcelain = ""): ForwardDependencies => ({
    environment: {},
    log: () => {},
    run: (argv) => ({
      status: 0,
      stderr: "",
      stdout: Buffer.from(argv.includes("submodule") ? status : porcelain),
    }),
  });
  const clean = ` ${"a".repeat(40)} vendor/x (heads/main)\n`;

  test("a repository without submodules, or with clean ones, forwards", () => {
    const root = mkdtempSync(join(tmpdir(), "le-submodules-"));
    try {
      expect(() => assertCleanSubmodules(deps(`+${"a".repeat(40)} vendor/x (heads/main)\n`), root)).not.toThrow();
      writeFileSync(join(root, ".gitmodules"), "[submodule \"x\"]\n");
      expect(() => assertCleanSubmodules(deps(clean), root)).not.toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a moved or modified submodule keeps the run here", () => {
    const root = mkdtempSync(join(tmpdir(), "le-submodules-"));
    try {
      writeFileSync(join(root, ".gitmodules"), "[submodule \"x\"]\n");
      expect(() => assertCleanSubmodules(deps(`+${"a".repeat(40)} vendor/x (heads/main)\n`), root))
        .toThrow(/submodule vendor\/x has changes/u);
      expect(() => assertCleanSubmodules(deps(clean, " M vendor/x\n"), root)).toThrow(ForwardUnavailableError);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("long runs stay on the workstation", () => {
  test("host-run forwards runs that may hold for an hour or less", () => {
    expect(forwardsHold(undefined)).toBe(true);
    expect(forwardsHold(60 * 60_000)).toBe(true);
    expect(forwardsHold(60 * 60_000 + 1)).toBe(false);
    expect(forwardsHold(null)).toBe(false);
  });

  /** A workstation whose remote.json forwards heavy compute to a host that does not exist. */
  function workstation(): { readonly environment: NodeJS.ProcessEnv; readonly root: string } {
    const root = mkdtempSync(join(tmpdir(), "le-forward-hold-"));
    mkdirSync(join(root, "config", "host-run"), { recursive: true });
    writeFileSync(
      join(root, "config", "host-run", "remote.json"),
      JSON.stringify({ compute: { forwardTo: "host-run-test-unreachable" } }),
    );
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, `
      import { closeSync, openSync } from "node:fs";
      export function createHostResourceCoordinator() {
        return {
          async withLease(claims, callback) {
            const descriptor = openSync(${JSON.stringify(join(root, "lease"))}, "a+");
            try { return await callback({ inheritedFileDescriptor: descriptor }); } finally { closeSync(descriptor); }
          },
        };
      }
    `);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ATET_HOST_RESOURCES_MODULE: modulePath,
      LOCAL_EFFICIENCY_LENDING: "off",
      LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
      XDG_CONFIG_HOME: join(root, "config"),
    };
    for (const key of ["LOCAL_EFFICIENCY_FORWARDED", "LOCAL_EFFICIENCY_LEASE", "LOCAL_EFFICIENCY_MACHINE_LOCK_CONFIG"]) {
      delete environment[key];
    }
    return { environment, root };
  }

  function hostRun(environment: NodeJS.ProcessEnv, root: string, flags: readonly string[]) {
    const marker = `require("node:fs").writeFileSync(${JSON.stringify(join(root, "ran"))}, "")`;
    return Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "host-run.ts"), ...flags, "--", process.execPath, "-e", marker],
      cwd: root,
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
  }

  test("--remote refuses a run that may hold longer than an hour, before it contacts the other Mac", () => {
    const { environment, root } = workstation();
    try {
      for (const [hold, limit] of [["--max-hold=2h", "for up to 2h00m"], ["--max-hold=none", "with no time limit"]] as const) {
        const result = hostRun(environment, root, ["--mode=heavy", "--remote", hold, "--label=soak"]);
        const stderr = result.stderr.toString();
        expect(result.exitCode, stderr).toBe(69);
        expect(stderr).toContain(`soak was not forwarded: it may run ${limit}, and a forwarded run holds`
          + " host-run-test-unreachable's CI machine lock for its whole run. Run it here with --local");
        expect(stderr).not.toContain("forwarding heavy compute");
        expect(existsSync(join(root, "ran"))).toBe(false);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a heavy run that may hold longer than an hour runs here", () => {
    const { environment, root } = workstation();
    try {
      const result = hostRun(environment, root, ["--mode=heavy", "--max-hold=9h", "--label=soak"]);
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr).toBe(0);
      expect(stderr).toContain("keeping soak on this Mac: it may run for up to 9h00m");
      expect(stderr).not.toContain("forwarding heavy compute");
      expect(existsSync(join(root, "ran"))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
