import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type ForwardDependencies,
  ForwardUnavailableError,
  forwardDeadlineMilliseconds,
  forwardUnavailableExitCode,
  newForwardId,
  normalizeOriginUrl,
  parseRemoteForwardConfig,
  parseRemoteRepositoryList,
  planForward,
  remoteConfigPath,
  remoteHostRunArguments,
  resolveRemoteForwardConfig,
  selectRemoteRepository,
  shellQuote,
  sshCommand,
  validateArtifactPath,
} from "./mac-ui-forward";
import { parseHostRunArguments } from "./host-run";

const hostRunScript = join(import.meta.dir, "host-run.ts");

describe("mac-ui forwarding config", () => {
  test("absent config runs locally; the default path follows XDG_CONFIG_HOME then HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "le-forward-config-"));
    try {
      expect(remoteConfigPath({ HOME: "/opt/home-a" }, "/ignored")).toBe("/opt/home-a/.config/host-run/remote.json");
      expect(remoteConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/opt/home-a" })).toBe("/xdg/host-run/remote.json");
      expect(() => remoteConfigPath({ XDG_CONFIG_HOME: "relative" })).toThrow("absolute");
      expect(resolveRemoteForwardConfig({ XDG_CONFIG_HOME: root })).toBeNull();
      mkdirSync(join(root, "host-run"));
      writeFileSync(join(root, "host-run", "remote.json"), JSON.stringify({ macUi: { forwardTo: "hra2" } }));
      expect(resolveRemoteForwardConfig({ XDG_CONFIG_HOME: root })).toEqual({
        forwardTo: "hra2",
        remoteHostRun: "host-run",
        source: join(root, "host-run", "remote.json"),
      });
      expect(resolveRemoteForwardConfig({ LOCAL_EFFICIENCY_REMOTE_CONFIG: join(root, "host-run", "remote.json") }))
        .toMatchObject({ forwardTo: "hra2" });
      // An explicit file must exist: the variable cannot switch forwarding off.
      expect(() => resolveRemoteForwardConfig({ LOCAL_EFFICIENCY_REMOTE_CONFIG: join(root, "missing.json") })).toThrow("cannot read");
      expect(() => resolveRemoteForwardConfig({ LOCAL_EFFICIENCY_REMOTE_CONFIG: "rel.json" })).toThrow("absolute");
      writeFileSync(join(root, "host-run", "remote.json"), "{ not json");
      expect(() => resolveRemoteForwardConfig({ XDG_CONFIG_HOME: root })).toThrow("not valid JSON");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects unknown keys and unsafe values instead of silently running locally", () => {
    expect(parseRemoteForwardConfig("{}")).toBeNull();
    expect(parseRemoteForwardConfig(JSON.stringify({ macUi: { forwardTo: "benguo@hra2.local", remoteHostRun: "/opt/remote/host-run.ts" } })))
      .toMatchObject({ forwardTo: "benguo@hra2.local", remoteHostRun: "/opt/remote/host-run.ts" });
    for (const bad of [
      [],
      { macUI: { forwardTo: "hra2" } },
      { macUi: { forwardto: "hra2" } },
      { macUi: { forwardTo: "" } },
      { macUi: { forwardTo: "-oProxyCommand=evil" } },
      { macUi: { forwardTo: "hra2; rm" } },
      { macUi: { forwardTo: "hra2", remoteHostRun: "relative/host-run" } },
      { macUi: { forwardTo: "hra2", remoteHostRun: "/a/../b" } },
      { macUi: "hra2" },
    ]) {
      expect(() => parseRemoteForwardConfig(JSON.stringify(bad))).toThrow();
    }
  });
});

describe("mac-ui forwarding command construction", () => {
  test("validates artifact paths relative to the repository root", () => {
    expect(validateArtifactPath("build/results.xcresult/")).toBe("build/results.xcresult");
    expect(validateArtifactPath("./out//a.txt")).toBe("out/a.txt");
    for (const bad of ["", "/abs", "..", "../x", "a/../../x", ".", "-rf", "a\nb"]) {
      expect(() => validateArtifactPath(bad)).toThrow();
    }
    expect(parseHostRunArguments(["--lane=mac-ui", "--artifacts=a", "--artifacts=b/", "--artifacts=a", "--", "true"]).artifacts)
      .toEqual(["a", "b"]);
    expect(() => parseHostRunArguments(["--lane=mac-native", "--artifacts=a", "--", "true"])).toThrow("only valid with --lane=mac-ui");
  });

  test("normalizes origin URLs and picks the matching remote clone", () => {
    for (const url of [
      "git@github.com:hraness/OH-app.git",
      "https://github.com/hraness/oh-app",
      "https://token@github.com/hraness/oh-app.git/",
      "ssh://git@github.com:22/hraness/oh-app.git",
      "ssh://git@github.com/hraness/oh-app",
    ]) expect(normalizeOriginUrl(url)).toBe("github.com/hraness/oh-app");
    const listed = parseRemoteRepositoryList([
      "dir\t/opt/remote/src/oh-board-validation\thttps://github.com/hraness/oh-app.git",
      "file\t/opt/remote/src/oh-app-wt\tgit@github.com:hraness/oh-app.git",
      "dir\t/opt/remote/src/oh-app\tgit@github.com:hraness/oh-app.git",
      "dir\t/opt/remote/src/sponge\tgit@github.com:hraness/sponge.git",
      "garbage line",
    ].join("\n"));
    expect(listed).toHaveLength(4);
    expect(selectRemoteRepository(listed, "https://github.com/hraness/oh-app")?.path).toBe("/opt/remote/src/oh-app");
    expect(selectRemoteRepository(listed.filter((entry) => entry.path !== "/opt/remote/src/oh-app"), "git@github.com:hraness/oh-app")?.path)
      .toBe("/opt/remote/src/oh-board-validation");
    expect(selectRemoteRepository(listed, "git@github.com:hraness/textmock.git")).toBeNull();
  });

  test("quotes every remote argument so the remote shell sees the exact argv", () => {
    const tricky = ["plain", "two words", "it's", "$HOME", "`date`", "a\"b", "semi;colon", "", "new\nline", "*"];
    const argv = sshCommand("hra2", 'printf "<%s>\\n" "$@"', "list", tricky);
    expect(argv.slice(0, -2)).toEqual([
      "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=6",
    ]);
    expect(argv.at(-2)).toBe("hra2");
    const remote = argv.at(-1)!;
    const result = spawnSync("/bin/sh", ["-c", remote], { encoding: "utf8" });
    expect(result.stdout).toBe(["list", ...tricky].map((value) => `<${value}>\n`).join(""));
    expect(shellQuote("abc/def.txt")).toBe("abc/def.txt");
    expect(shellQuote("a b")).toBe("'a b'");
  });

  test("runs the same mode, label and max hold under the remote mac-ui lane", () => {
    const request = { artifacts: [], command: ["xcodebuild", "test", "-scheme", "App UI"], cwd: "/x", label: "ui", mode: "heavy" as const };
    expect(remoteHostRunArguments(request)).toEqual([
      "--mode=heavy", "--lane=mac-ui", "--label=ui", "--", "xcodebuild", "test", "-scheme", "App UI",
    ]);
    expect(remoteHostRunArguments({ ...request, maxHoldMilliseconds: 90 * 60_000 })).toContain("--max-hold=5400000ms");
    expect(remoteHostRunArguments({ ...request, maxHoldMilliseconds: null })).toContain("--max-hold=none");
    expect(forwardDeadlineMilliseconds(undefined)).toBe((120 + 120 + 60 + 15) * 60_000);
    expect(forwardDeadlineMilliseconds(10 * 60_000)).toBe((120 + 120 + 10 + 15) * 60_000);
    expect(forwardDeadlineMilliseconds(null)).toBe((120 + 120 + 24 * 60 + 15) * 60_000);
    expect(newForwardId(new Date("2026-11-25T01:02:03.456Z"))).toMatch(/^20261125-010203-[0-9a-f]{8}$/u);
  });

  test("plans a bundle only when the remote clone lacks HEAD, excluding commits it has", () => {
    const head = "a".repeat(40);
    const shared = "b".repeat(40);
    const missing = "c".repeat(40);
    const calls: string[][] = [];
    const deps = (remoteHas: readonly string[]): ForwardDependencies => ({
      environment: {},
      log: () => {},
      run: (argv) => {
        calls.push([...argv]);
        const out = (text: string) => ({ status: 0, stderr: "", stdout: Buffer.from(text) });
        if (argv[0] === "git") {
          const joined = argv.slice(1).join(" ");
          if (joined === "rev-parse --show-toplevel") return out("/repo\n");
          if (joined === "rev-parse --show-prefix") return out("sub/\n");
          if (joined.startsWith("rev-parse --verify")) return out(`${head}\n`);
          if (joined === "remote get-url origin") return out("git@github.com:o/r.git\n");
          if (joined.startsWith("for-each-ref")) return out(`${shared}\n${missing}\n`);
        }
        if (argv[0] === "ssh") {
          const remote = argv.at(-1)!;
          if (remote.includes(" list")) return out("dir\t/r/src/r\thttps://github.com/o/r\n");
          if (remote.includes(" have ")) return out(remoteHas.map((sha) => `${sha}\n`).join(""));
        }
        return { status: 1, stderr: `unexpected ${argv.join(" ")}`, stdout: Buffer.alloc(0) };
      },
    });
    const config = { forwardTo: "hra2", remoteHostRun: "host-run", source: "test" };
    const needsBundle = planForward(deps([shared]), config, "true", "/repo/sub");
    expect(needsBundle).toEqual({
      bundleNeeded: true,
      haves: [shared],
      local: { head, origin: "git@github.com:o/r.git", prefix: "sub", root: "/repo" },
      remoteRepository: "/r/src/r",
    });
    const haveCall = calls.find((argv) => argv[0] === "ssh" && argv.at(-1)!.includes(" have "))!;
    expect(haveCall.at(-1)).toContain(`/r/src/r ${head} ${shared} ${missing}`);
    expect(planForward(deps([head, shared]), config, "true", "/repo/sub")).toMatchObject({ bundleNeeded: false, haves: [shared] });
  });

  test("fails closed with a clear error when the host is unreachable or has no clone", () => {
    const base = (sshResult: { status: number; stdout: string; stderr: string }): ForwardDependencies => ({
      environment: {},
      log: () => {},
      run: (argv) => {
        if (argv[0] === "git") {
          const map: Record<string, string> = {
            "rev-parse --show-toplevel": "/repo",
            "rev-parse --show-prefix": "",
            "remote get-url origin": "git@github.com:o/r.git",
          };
          const key = argv.slice(1).join(" ");
          return { status: 0, stderr: "", stdout: Buffer.from(map[key] ?? "a".repeat(40)) };
        }
        return { ...sshResult, stdout: Buffer.from(sshResult.stdout) };
      },
    });
    const config = { forwardTo: "hra2", remoteHostRun: "host-run", source: "/cfg/remote.json" };
    expect(() => planForward(base({ status: 255, stdout: "", stderr: "ssh: connect to host hra2 port 22: Operation timed out" }), config, "true", "/repo"))
      .toThrow(/cannot reach hra2 over ssh.*Operation timed out.*never run on this workstation.*\/cfg\/remote\.json/su);
    expect(() => planForward(base({ status: 0, stdout: "dir\t/r/src/x\tgit@github.com:o/x.git\n", stderr: "" }), config, "true", "/repo"))
      .toThrow(ForwardUnavailableError);
    expect(() => planForward(base({ status: 0, stdout: "", stderr: "" }), config, "true", "/repo"))
      .toThrow("has no clone of github.com/o/r under ~/src");
  });
});

// ---- end to end through a fake ssh that runs the remote half on this machine ----

function sh(cwd: string, command: string): string {
  const result = spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout.trim();
}

const passThroughModule = (root: string): string => {
  const modulePath = join(root, "host-resources.js");
  writeFileSync(modulePath, `
    import { closeSync, openSync, appendFileSync } from "node:fs";
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

type Fixture = {
  readonly env: NodeJS.ProcessEnv;
  readonly local: string;
  readonly remoteClone: string;
  readonly remoteHome: string;
  readonly root: string;
};

function fixture(options: { readonly remoteClone?: boolean; readonly config?: object } = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "le-forward-e2e-")));
  const git = "git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false";
  const origin = join(root, "origin.git");
  sh(root, `git init --quiet --bare -b main ${origin} && git init --quiet -b main seed`);
  const seed = join(root, "seed");
  writeFileSync(join(seed, "notes.txt"), "committed\n");
  writeFileSync(join(seed, "gone.txt"), "delete me\n");
  mkdirSync(join(seed, "sub"));
  writeFileSync(join(seed, "sub", "keep.txt"), "sub\n");
  sh(seed, `${git} add -A && ${git} commit --quiet -m seed && git remote add origin ${origin} && git push --quiet origin main`);
  const remoteHome = join(root, "remote-home");
  const remoteClone = join(remoteHome, "src", "proj");
  mkdirSync(join(remoteHome, "src"), { recursive: true });
  if (options.remoteClone !== false) {
    sh(root, `git clone --quiet ${origin} ${remoteClone} && git -C ${remoteClone} remote set-url origin https://github.com/test/proj.git`);
  }
  const local = join(root, "local");
  sh(root, `git clone --quiet ${origin} ${local}`);
  writeFileSync(join(local, "later.txt"), "a commit the remote clone lacks\n");
  sh(local, `${git} add later.txt && ${git} commit --quiet -m later && git remote set-url origin git@github.com:test/proj.git`);
  // Uncommitted: a modified file, a deleted file, an untracked text and binary file, an ignored file.
  writeFileSync(join(local, "notes.txt"), "committed\nplus a local edit\n");
  rmSync(join(local, "gone.txt"));
  writeFileSync(join(local, "untracked.txt"), "untracked but not ignored\n");
  writeFileSync(join(local, "blob.bin"), Buffer.from([0, 1, 2, 255, 0, 10]));
  writeFileSync(join(local, ".gitignore"), "ignored.log\n");
  writeFileSync(join(local, "ignored.log"), "never shipped\n");

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), [
    "#!/bin/bash",
    "while [ $# -gt 0 ]; do case \"$1\" in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done",
    "host=$1; shift",
    "if [ -n \"${FAKE_SSH_FAIL:-}\" ]; then echo \"ssh: connect to host $host port 22: Connection refused\" >&2; exit 255; fi",
    "export HOME=\"$FAKE_REMOTE_HOME\"; unset XDG_CONFIG_HOME",
    "exec /bin/sh -c \"$*\"",
    "",
  ].join("\n"));
  chmodSync(join(bin, "ssh"), 0o755);
  const configHome = join(root, "config");
  mkdirSync(join(configHome, "host-run"), { recursive: true });
  writeFileSync(join(configHome, "host-run", "remote.json"), JSON.stringify(options.config ?? {
    macUi: { forwardTo: "fakehost", remoteHostRun: hostRunScript },
  }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["LOCAL_EFFICIENCY_LEASE", "LOCAL_EFFICIENCY_FORWARDED", "HRA_CHROME", "HRA_CHROME_REAL", "AGENT_BROWSER_EXECUTABLE_PATH"]) {
    delete env[key];
  }
  Object.assign(env, {
    ATET_HOST_RESOURCES_MODULE: passThroughModule(root),
    FAKE_REMOTE_HOME: remoteHome,
    GIT_CONFIG_NOSYSTEM: "1",
    LOCAL_EFFICIENCY_REMOTE_LAUNCHER: "direct",
    LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
    LOCAL_EFFICIENCY_TELEMETRY: "off",
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    XDG_CONFIG_HOME: configHome,
  });
  return { env, local, remoteClone, remoteHome, root };
}

function hostRun(f: Fixture, cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [hostRunScript, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...f.env, ...extraEnv },
    timeout: 120_000,
  });
}

function remoteRuns(f: Fixture): string[] {
  const root = join(f.remoteHome, ".local", "state", "host-run", "remote");
  return existsSync(root) ? readdirSync(root) : [];
}

// The remote half runs host-run --lane=mac-ui, which only runs on macOS, so
// the tests that reach the remote command run on macOS only. The fail-closed
// test never reaches it and runs everywhere.
const remoteMac = test.skipIf(process.platform !== "darwin");

describe("mac-ui forwarding end to end (fake ssh, direct launcher)", () => {
  remoteMac("runs at the local HEAD with uncommitted changes applied, returns the exit code, copies artifacts and cleans up", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const f = fixture();
    try {
      const head = sh(f.local, "git rev-parse HEAD");
      const statusBefore = sh(f.local, "git status --porcelain");
      const remoteRefsBefore = sh(f.remoteClone, "git for-each-ref --format='%(refname) %(objectname)'; git worktree list --porcelain; git status --porcelain");
      const result = hostRun(f, join(f.local, "sub"), [
        "--mode=shared", "--lane=mac-ui", "--label=e2e", "--artifacts=out/result.txt", "--artifacts=missing.txt", "--",
        "sh", "-c",
        "echo pwd=$(pwd); echo head=$(git rev-parse HEAD); cat ../notes.txt; cat ../untracked.txt; od -An -tx1 ../blob.bin;"
          + " test -e ../gone.txt || echo gone-deleted; test -e ../ignored.log || echo ignored-absent;"
          + " echo forwarded=$LOCAL_EFFICIENCY_FORWARDED; echo to-stderr >&2; mkdir -p ../out; echo artifact > ../out/result.txt; exit 3",
      ]);
      expect(result.status, result.stderr).toBe(3);
      expect(result.stdout).toContain(`head=${head}`);
      expect(result.stdout).toMatch(/pwd=.*\/\.local\/state\/host-run\/remote\/[0-9a-f-]+\/tree\/sub\n/u);
      expect(result.stdout).toContain("committed\nplus a local edit\n");
      expect(result.stdout).toContain("untracked but not ignored\n");
      expect(result.stdout).toMatch(/00\s+01\s+02\s+ff\s+00\s+0a/u);
      expect(result.stdout).toContain("gone-deleted");
      expect(result.stdout).toContain("ignored-absent");
      expect(result.stdout).toContain("forwarded=1");
      expect(result.stderr).toContain("to-stderr");
      expect(result.stderr).toContain("forwarding shared mac-ui e2e to fakehost");
      expect(result.stderr).toContain("+ bundle");
      expect(result.stderr).toContain("artifact not found: missing.txt");
      expect(readFileSync(join(f.local, "out", "result.txt"), "utf8")).toBe("artifact\n");
      // The remote ran under its own mac-ui lease.
      const claims = readFileSync(join(f.root, "claims.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(claims[0]).toEqual({ profile: "local-efficiency/mac-ui-v1", claims: [{ resource: "mac-ui", amount: 1 }] });
      // Cleanup and isolation: no remote run left, the remote clone is untouched, the local index is untouched.
      expect(remoteRuns(f)).toEqual([]);
      expect(sh(f.remoteClone, "git for-each-ref --format='%(refname) %(objectname)'; git worktree list --porcelain; git status --porcelain"))
        .toBe(remoteRefsBefore);
      expect(sh(f.local, "git status --porcelain").split("\n").sort()).toEqual([...statusBefore.split("\n"), "?? out/"].sort());
      expect(sh(f.local, "git diff --cached --name-only")).toBe("");
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  remoteMac("sends no bundle when the remote clone already has HEAD", () => {
    const f = fixture();
    try {
      sh(f.local, `git push --quiet ${join(f.root, "origin.git")} HEAD:main`);
      sh(f.remoteClone, `git fetch --quiet ${join(f.root, "origin.git")} main`);
      const result = hostRun(f, f.local, ["--lane=mac-ui", "--label=nobundle", "--", "git", "rev-parse", "HEAD"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(sh(f.local, "git rev-parse HEAD"));
      expect(result.stderr).not.toContain("+ bundle");
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  test("fails closed and never runs locally when the host is unreachable or lacks the repository", () => {
    const f = fixture({ remoteClone: false });
    try {
      const marker = join(f.root, "ran-locally");
      const command = ["--lane=mac-ui", "--label=closed", "--", "sh", "-c", `touch ${marker}`];
      const unreachable = hostRun(f, f.local, command, { FAKE_SSH_FAIL: "1" });
      expect(unreachable.status).toBe(forwardUnavailableExitCode);
      expect(unreachable.stderr).toContain("MAC_UI_FORWARD_FAILED: cannot reach fakehost over ssh");
      expect(unreachable.stderr).toContain("Connection refused");
      const missing = hostRun(f, f.local, command);
      expect(missing.status).toBe(forwardUnavailableExitCode);
      expect(missing.stderr).toContain("fakehost has no clone of github.com/test/proj under ~/src");
      const notRepo = hostRun(f, f.root, command);
      expect(notRepo.status).toBe(forwardUnavailableExitCode);
      expect(notRepo.stderr).toContain("needs a Git repository");
      const again = hostRun(f, f.local, command, { LOCAL_EFFICIENCY_FORWARDED: "1" });
      expect(again.status).toBe(forwardUnavailableExitCode);
      expect(again.stderr).toContain("already forwarded");
      writeFileSync(join(f.env.XDG_CONFIG_HOME!, "host-run", "remote.json"), JSON.stringify({ macUi: { forwardTo: "" } }));
      const malformed = hostRun(f, f.local, command);
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain("macUi.forwardTo");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(f.root, "claims.log"))).toBe(false);
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  remoteMac("a local interrupt stops the remote run and removes its tree", async () => {
    const f = fixture();
    try {
      const tag = `hostrun-cancel-${process.pid}-${Date.now()}`;
      const child = spawn(process.execPath, [hostRunScript, "--lane=mac-ui", "--label=cancel", "--",
        "sh", "-c", `echo ready; exec -a ${tag} sleep 60`], {
        cwd: f.local,
        env: f.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const deadline = Date.now() + 60_000;
      while (!stdout.includes("ready") && Date.now() < deadline) await Bun.sleep(100);
      expect(stdout, stderr).toContain("ready");
      expect(remoteRuns(f)).toHaveLength(1);
      const started = Date.now();
      child.kill("SIGINT");
      const code = await new Promise<number | null>((resolveExit) => child.once("exit", (exitCode) => resolveExit(exitCode)));
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(code, stderr).not.toBe(0);
      expect(stderr).toContain("SIGINT: stopping the mac-ui run on fakehost");
      expect(remoteRuns(f)).toEqual([]);
      expect(spawnSync("pgrep", ["-f", tag]).status).toBe(1);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);
});
