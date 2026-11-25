import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCleanSubmodules, forwardedEnvironment } from "./compute-forward";
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
