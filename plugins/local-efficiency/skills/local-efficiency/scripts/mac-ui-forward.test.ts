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
  buildPayload,
  defaultForwardDependencies,
  type ForwardDependencies,
  type ForwardPlan,
  ForwardUnavailableError,
  forwardDeadlineMilliseconds,
  forwardUnavailableExitCode,
  remoteScriptPath,
  newForwardId,
  normalizeOriginUrl,
  originWithoutCredentials,
  parseRemoteConfigs,
  parseRemoteForwardConfig,
  parseRemoteRepositoryList,
  repositoryKey,
  planForward,
  remoteConfigPath,
  remoteHostRunArguments,
  resolveRemoteConfigs,
  resolveRemoteForwardConfig,
  selectRemoteRepository,
  shellQuote,
  sshCommand,
  validateArtifactPath,
} from "./mac-ui-forward";
import { parseHostRunArguments, permitCapacity } from "./host-run";

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
        seedMaxBytes: 2048 * 1_048_576,
        source: join(root, "host-run", "remote.json"),
      });
      expect(resolveRemoteConfigs({ XDG_CONFIG_HOME: root }).compute).toBeNull();
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
      { macUi: { forwardTo: "hra2", seedMaxMiB: -1 } },
      { macUi: { forwardTo: "hra2", modes: ["heavy"] } },
    ]) {
      expect(() => parseRemoteForwardConfig(JSON.stringify(bad))).toThrow();
    }
  });

  test("parses the compute entry with heavy-only defaults, independent of macUi", () => {
    const both = parseRemoteConfigs(JSON.stringify({
      macUi: { forwardTo: "hra2" },
      compute: { forwardTo: "hra2", modes: ["heavy", "exclusive"] },
    }), "/cfg/remote.json");
    expect(both.macUi).toMatchObject({ forwardTo: "hra2" });
    expect(both.compute).toEqual({
      cacheGiB: 80,
      forwardTo: "hra2",
      minFreeGiB: 60,
      modes: ["heavy", "exclusive"],
      remoteHostRun: "host-run",
      seedMaxBytes: 2048 * 1_048_576,
      slots: 2,
      source: "/cfg/remote.json",
    });
    expect(parseRemoteConfigs(JSON.stringify({ compute: { forwardTo: "hra2", modes: ["exclusive"], slots: 3, cacheGiB: 10 } })))
      .toMatchObject({ macUi: null, compute: { modes: ["exclusive"], slots: 3, cacheGiB: 10 } });
    for (const bad of [
      { compute: { forwardTo: "hra2", modes: ["shared"] } },
      { compute: { forwardTo: "hra2", modes: [] } },
      { compute: { forwardTo: "hra2", slots: 0 } },
      { compute: { forwardTo: "hra2", slots: 9 } },
      { compute: { forwardTo: "hra2", cacheGiB: 1.5 } },
      { compute: { forwardTo: "hra2", lane: "compute" } },
      { compute: { forwardTo: "hra2; rm" } },
      { computer: { forwardTo: "hra2" } },
    ]) {
      expect(() => parseRemoteConfigs(JSON.stringify(bad))).toThrow();
    }
  });

  test("parses presence placement with defaults; it is off unless the key is present", () => {
    expect(parseRemoteConfigs(JSON.stringify({ macUi: { forwardTo: "hra2" } })).presence).toBeNull();
    expect(parseRemoteConfigs(JSON.stringify({ presence: {} })).presence)
      .toEqual({ graceSeconds: 15, keyIdleMinutes: 5, pollSeconds: 2, waitMinutes: 60 });
    expect(parseRemoteConfigs(JSON.stringify({ presence: { keyIdleMinutes: 10, waitMinutes: 5 } })).presence)
      .toMatchObject({ keyIdleMinutes: 10, waitMinutes: 5 });
    for (const bad of [
      { presence: true },
      { presence: { keyIdleMinutes: 0 } },
      { presence: { keyIdleMinutes: 1.5 } },
      { presence: { pollSeconds: 11 } },
      { presence: { waitMinutes: 241 } },
      { presence: { idleMinutes: 5 } },
    ]) {
      expect(() => parseRemoteConfigs(JSON.stringify(bad))).toThrow();
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

  test("plans to send commits only when the remote clone lacks HEAD, excluding commits it has", () => {
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
    const needsCommits = planForward(deps([shared]), config, "true", "/repo/sub");
    expect(needsCommits).toEqual({
      commitsNeeded: true,
      haves: [shared],
      local: { head, origin: "git@github.com:o/r.git", prefix: "sub", root: "/repo" },
      missing: [],
      partial: false,
      remoteRepository: "/r/src/r",
    });
    const haveCall = calls.find((argv) => argv[0] === "ssh" && argv.at(-1)!.includes(" have "))!;
    expect(haveCall.at(-1)).toContain(`/r/src/r ${head} ${shared} ${missing}`);
    expect(planForward(deps([head, shared]), config, "true", "/repo/sub")).toMatchObject({ commitsNeeded: false, haves: [shared] });
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

/** 400 numbered lines: big enough that a one-line change to them is packed as a delta. */
function numberedLines(name: string): string {
  return Array.from({ length: 400 }, (_, index) => `${name} line ${index + 1} of a file big enough to be packed as a delta\n`).join("");
}

type FixtureOptions = {
  readonly config?: object;
  /** The first commit has big.txt, and the local commit adds a line to it. */
  readonly bigFile?: boolean;
  /**
   * Before the remote clone is made, origin's main gains a fix (fix.txt) and
   * branch `older` stays at the first commit. The local commit is made on a
   * branch from `older` with the fix cherry-picked, so fix.txt's contents are
   * in origin/main but not in the commit the sent ones build on.
   */
  readonly cherryPick?: boolean;
  /**
   * After the remote clone is made, origin's main gains a commit that adds
   * x.txt and a pull request branch `pr` changes it. The remote clone fetches
   * `pr` into FETCH_HEAD only and checks it out in a worktree outside ~/src,
   * so it has those commits but no ref there reaches them (HRA2's clone on
   * 2026-11-26). The local commit is made on top of `pr`.
   */
  readonly pullRequest?: boolean;
  readonly remoteClone?: boolean | "partial";
};

function fixture(options: FixtureOptions = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "le-forward-e2e-")));
  const git = "git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false";
  const origin = join(root, "origin.git");
  sh(root, `git init --quiet --bare -b main ${origin} && git init --quiet -b main seed`);
  const seed = join(root, "seed");
  writeFileSync(join(seed, "notes.txt"), "committed\n");
  writeFileSync(join(seed, "gone.txt"), "delete me\n");
  mkdirSync(join(seed, "sub"));
  writeFileSync(join(seed, "sub", "keep.txt"), "sub\n");
  if (options.bigFile === true) writeFileSync(join(seed, "big.txt"), numberedLines("big"));
  sh(seed, `${git} add -A && ${git} commit --quiet -m seed && git remote add origin ${origin} && git push --quiet origin main`);
  if (options.cherryPick === true) {
    writeFileSync(join(seed, "fix.txt"), "a fix made on main\n");
    sh(seed, `git branch older && ${git} add fix.txt && ${git} commit --quiet -m fix && git push --quiet origin main older`);
  }
  const remoteHome = join(root, "remote-home");
  const remoteClone = join(remoteHome, "src", "proj");
  mkdirSync(join(remoteHome, "src"), { recursive: true });
  if (options.pullRequest === true && options.remoteClone === false) throw new Error("pullRequest needs a remote clone");
  const fetchPullRequest = (served: string): void => {
    if (options.pullRequest !== true) return;
    writeFileSync(join(seed, "x.txt"), numberedLines("x"));
    sh(seed, `${git} add x.txt && ${git} commit --quiet -m main-later && git switch --quiet -c pr`);
    writeFileSync(join(seed, "x.txt"), `${numberedLines("x")}a pull request line\n`);
    sh(seed, `${git} commit --quiet -am pull-request && git push --quiet origin main pr`);
    if (served !== origin) sh(seed, `git push --quiet ${served} main pr`);
    sh(remoteClone, `git fetch --quiet --refmap= origin pr && git worktree add --quiet --detach ${join(root, "remote-worktree")} FETCH_HEAD`);
  };
  if (options.remoteClone === "partial") {
    // A blob-less clone whose promisor remote is gone, like a clone on a Mac
    // without credentials for the origin: missing blobs cannot be fetched.
    const served = join(root, "served.git");
    sh(root, `git clone --quiet --bare ${origin} ${served} && git -C ${served} config uploadpack.allowFilter true`);
    sh(root, `git clone --quiet --filter=blob:none --no-checkout file://${served} ${remoteClone}`);
    fetchPullRequest(served);
    rmSync(served, { force: true, recursive: true });
    sh(root, `git -C ${remoteClone} remote set-url origin https://github.com/test/proj.git`);
  } else if (options.remoteClone !== false) {
    sh(root, `git clone --quiet ${origin} ${remoteClone}`);
    fetchPullRequest(origin);
    sh(root, `git -C ${remoteClone} remote set-url origin https://github.com/test/proj.git`);
  }
  const local = join(root, "local");
  sh(root, `git clone --quiet ${origin} ${local}`);
  if (options.pullRequest === true) sh(local, "git switch --quiet -c topic origin/pr");
  // -x: made in the same second as the fix, the cherry-pick would otherwise be that very commit.
  if (options.cherryPick === true) sh(local, `git switch --quiet -c topic origin/older && ${git} cherry-pick -x origin/main`);
  writeFileSync(join(local, "later.txt"), "a commit the remote clone lacks\n");
  if (options.bigFile === true) writeFileSync(join(local, "big.txt"), `${numberedLines("big")}one more line\n`);
  sh(local, `${git} add -A && ${git} commit --quiet -m later && git remote set-url origin git@github.com:test/proj.git`);
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
    "# Real ssh does not carry the workstation's environment; drop what a test names.",
    "for name in ${FAKE_SSH_DROP:-}; do unset \"$name\"; done",
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
      expect(result.stderr).toContain(`(${head.slice(0, 12)} + 1 commit, clone `);
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

  remoteMac("sends no commits when the remote clone already has HEAD", () => {
    const f = fixture();
    try {
      sh(f.local, `git push --quiet ${join(f.root, "origin.git")} HEAD:main`);
      sh(f.remoteClone, `git fetch --quiet ${join(f.root, "origin.git")} main`);
      const result = hostRun(f, f.local, ["--lane=mac-ui", "--label=nocommits", "--", "git", "rev-parse", "HEAD"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(sh(f.local, "git rev-parse HEAD"));
      expect(result.stderr).toContain(`(${sh(f.local, "git rev-parse --short=12 HEAD")}, clone `);
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
      writeFileSync(join(f.env.XDG_CONFIG_HOME!, "host-run", "remote.json"), JSON.stringify({ macUi: { forwardTo: "fakehost", seedMaxMiB: 0 } }));
      const missing = hostRun(f, f.local, command);
      expect(missing.status).toBe(forwardUnavailableExitCode);
      expect(missing.stderr).toContain("fakehost has no clone of github.com/test/proj, and seeding is off");
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

// The helper's launchd test needs a GUI launchd domain (a logged-in console user).
const guiDomain = process.platform === "darwin"
  && spawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}`], { stdio: "ignore" }).status === 0;
const launchdMac = test.skipIf(!guiDomain);

function fakeRemoteHostRun(root: string): string {
  // Stands in for the remote host-run: runs the command after "--", so the
  // launchd job needs none of the test's environment.
  const path = join(root, "fake-host-run");
  writeFileSync(path, "#!/bin/bash\nwhile [ $# -gt 0 ] && [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n");
  chmodSync(path, 0o755);
  return path;
}

function configureHelper(f: Fixture, app: unknown): void {
  mkdirSync(join(f.remoteHome, ".config", "host-run"), { recursive: true });
  writeFileSync(join(f.remoteHome, ".config", "host-run", "mac-ui.json"), JSON.stringify({ helper: app === undefined ? {} : { app } }));
}

describe("mac-ui forwarding through the HostRun UI helper", () => {
  remoteMac("a configured helper that is missing or unsigned stops the run with 69 instead of falling back to bash", () => {
    const f = fixture();
    try {
      const marker = join(f.root, "ran");
      const command = ["--lane=mac-ui", "--label=helper-closed", "--", "sh", "-c", `touch ${marker}`];
      const app = join(f.root, "HostRun UI.app");
      configureHelper(f, app);
      const missing = hostRun(f, f.local, command);
      expect(missing.status).toBe(forwardUnavailableExitCode);
      expect(missing.stderr).toContain("is missing; run host-run mac-ui install-helper");
      mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
      writeFileSync(join(app, "Contents", "MacOS", "host-run-ui"), "#!/bin/bash\nexec /bin/bash \"$@\"\n");
      chmodSync(join(app, "Contents", "MacOS", "host-run-ui"), 0o755);
      const unsigned = hostRun(f, f.local, command);
      expect(unsigned.status).toBe(forwardUnavailableExitCode);
      expect(unsigned.stderr).toContain("does not pass codesign --verify");
      configureHelper(f, undefined);
      const malformed = hostRun(f, f.local, command);
      expect(malformed.status).toBe(forwardUnavailableExitCode);
      expect(malformed.stderr).toContain("has no helper.app");
      expect(existsSync(marker)).toBe(false);
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  launchdMac("runs the job in the GUI session under the helper app and passes output and exit code through", async () => {
    const f = fixture();
    try {
      const { installHelper } = await import("./mac-ui-helper");
      const app = join(f.root, "Apps", "HostRun UI.app");
      installHelper({ appPath: app, configPath: join(f.remoteHome, ".config", "host-run", "mac-ui.json"), log: () => {} });
      writeFileSync(join(f.env.XDG_CONFIG_HOME!, "host-run", "remote.json"), JSON.stringify({
        macUi: { forwardTo: "fakehost", remoteHostRun: fakeRemoteHostRun(f.root) },
      }));
      const result = hostRun(f, f.local, ["--lane=mac-ui", "--label=helper", "--", "sh", "-c",
        "echo responsible=$(ps -o comm= -p $(ps -o ppid= -p $PPID)); echo oops >&2; exit 5"],
      { LOCAL_EFFICIENCY_REMOTE_LAUNCHER: "launchd" });
      expect(result.status, result.stderr).toBe(5);
      expect(result.stdout).toContain(`responsible=${join(app, "Contents", "MacOS", "host-run-ui")}`);
      expect(result.stderr).toContain("oops");
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);
});

// ---- seeding and heavy compute forwarding (same fake ssh) ----

describe("remote repository names and seeding", () => {
  test("strips credentials from the seeded origin and derives a stable state directory name", () => {
    expect(originWithoutCredentials("https://user:secret@github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(originWithoutCredentials("https://x-access-token@github.com/o/r")).toBe("https://github.com/o/r");
    expect(originWithoutCredentials("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(repositoryKey("git@github.com:Hraness/OH-Router.git")).toBe("github.com-hraness-oh-router");
    expect(repositoryKey("https://github.com/hraness/oh-router")).toBe("github.com-hraness-oh-router");
    expect(selectRemoteRepository(parseRemoteRepositoryList([
      "seed\t/h/.local/state/host-run/seed/github.com-o-r\tgit@github.com:o/r.git",
      "file\t/h/src/r-wt\tgit@github.com:o/r.git",
    ].join("\n")), "git@github.com:o/r.git")?.path).toBe("/h/src/r-wt");
    expect(selectRemoteRepository(parseRemoteRepositoryList(
      "seed\t/h/.local/state/host-run/seed/github.com-o-r\tgit@github.com:o/r.git\n",
    ), "https://github.com/o/r")?.kind).toBe("seed");
  });

  remoteMac("seeds a repository the remote lacks into host-run state, never ~/src, then sends only new commits", () => {
    const f = fixture({ remoteClone: false, bigFile: true });
    try {
      const first = hostRun(f, f.local, ["--lane=mac-ui", "--label=seeded", "--", "git", "rev-parse", "HEAD"]);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout.trim()).toBe(sh(f.local, "git rev-parse HEAD"));
      expect(first.stderr).toContain("fakehost has no clone of github.com/test/proj; sending a one-time copy");
      expect(first.stderr).toMatch(/seeded fakehost with github\.com\/test\/proj in [\d.]+s/u);
      const seed = join(f.remoteHome, ".local", "state", "host-run", "seed", "github.com-test-proj");
      expect(sh(seed, "git config --get remote.origin.url")).toBe("git@github.com:test/proj.git");
      expect(sh(seed, "git rev-parse refs/host-run/last")).toBe(sh(f.local, "git rev-parse HEAD"));
      expect(readdirSync(join(f.remoteHome, "src"))).toEqual([]);
      const second = hostRun(f, f.local, ["--lane=mac-ui", "--label=seeded", "--", "true"]);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stderr).not.toContain("one-time copy");
      expect(second.stderr).not.toMatch(/ \+ \d+ commits?,/u);
      // A new commit travels in a thin pack, which the seed completes from
      // its own big.txt, and advances the seed. The local commit origin lacks
      // travels again: no ref here says the seed has it.
      writeFileSync(join(f.local, "big.txt"), `${numberedLines("big")}one more line\nand one after it\n`);
      sh(f.local, "git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit --quiet -m next big.txt");
      const third = hostRun(f, f.local, ["--lane=mac-ui", "--label=seeded", "--", "git", "rev-parse", "HEAD"]);
      expect(third.status, third.stderr).toBe(0);
      expect(third.stderr).toContain(" + 2 commits, ");
      expect(sh(seed, "git rev-parse refs/host-run/last")).toBe(sh(f.local, "git rev-parse HEAD"));
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);
});

function computeConfig(f: Fixture, extra: object = {}): void {
  writeFileSync(join(f.env.XDG_CONFIG_HOME!, "host-run", "remote.json"), JSON.stringify({
    compute: { forwardTo: "fakehost", remoteHostRun: hostRunScript, ...extra },
  }));
}

function workspaceRoot(f: Fixture): string {
  return join(f.remoteHome, ".local", "state", "host-run", "compute", "github.com-test-proj");
}

const computeHost = test.skipIf(process.platform !== "darwin" && process.platform !== "linux");

describe("heavy compute forwarding end to end (fake ssh)", () => {
  computeHost("runs heavy work in a cached workspace under the remote compute lane with only allowlisted env", () => {
    const f = fixture();
    try {
      computeConfig(f);
      const marker = join(f.root, "ran-locally");
      const result = hostRun(f, join(f.local, "sub"), ["--mode=heavy", "--label=build", "--", "sh", "-c",
        `test "$LOCAL_EFFICIENCY_FORWARDED" = 1 || touch ${marker}; echo pwd=$(pwd); cat ../notes.txt;`
          + " echo incremental=${CARGO_INCREMENTAL:-unset} jobs=${HRA_JOBS:-unset} target=${CARGO_TARGET_DIR:-unset}"
          + " token=${CARGO_REGISTRY_TOKEN:-unset} gh=${GH_TOKEN:-unset}; echo lease=$LOCAL_EFFICIENCY_LEASE; exit 3"],
      {
        CARGO_INCREMENTAL: "0", CARGO_REGISTRY_TOKEN: "secret", CARGO_TARGET_DIR: "/opt/target", GH_TOKEN: "ghp_secret", HRA_JOBS: "3",
        FAKE_SSH_DROP: "CARGO_INCREMENTAL CARGO_REGISTRY_TOKEN CARGO_TARGET_DIR GH_TOKEN HRA_JOBS",
      });
      // A real failure on the remote is the answer: exit 3, no local rerun.
      expect(result.status, result.stderr).toBe(3);
      expect(existsSync(marker)).toBe(false);
      expect(result.stderr).toContain("exited 3 on fakehost");
      expect(result.stderr).toContain("not rerunning it here");
      expect(result.stdout).toContain(`pwd=${join(workspaceRoot(f), "slot-1", "tree", "sub")}`);
      expect(result.stdout).toContain("plus a local edit");
      expect(result.stdout).toContain("incremental=0 jobs=3 target=unset token=unset gh=unset");
      expect(result.stderr).toContain("forwarding heavy compute build to fakehost");
      // The caller's own allowlisted settings (MAKEFLAGS under a build runner) may also travel.
      expect(result.stderr).toMatch(/env [^,]*\bCARGO_INCREMENTAL\b[^,]*\bHRA_JOBS\b/u);
      expect(result.stderr).toContain("not sent: CARGO_REGISTRY_TOKEN CARGO_TARGET_DIR");
      expect(result.stdout).toMatch(/lease=\{[^\n]*"lane":"compute"/u);
      expect(result.stdout).toMatch(/lease=\{[^\n]*"mode":"heavy"/u);
      const claims = readFileSync(join(f.root, "claims.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const borrowed = claims.filter((entry) => String(entry.profile).includes("overflow"));
      expect(claims.length - borrowed.length).toBe(1);
      // On a 2-permit host a heavy run takes every permit, so it also takes every borrowed one.
      expect(borrowed).toHaveLength(permitCapacity() <= 2 ? 1 : 0);
      expect(remoteRuns(f)).toEqual([]);
      expect(existsSync(join(workspaceRoot(f), "slot-1.lock"))).toBe(false);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  computeHost("resets the workspace to the commit plus patch on every run and keeps ignored build output", () => {
    const f = fixture();
    try {
      computeConfig(f);
      writeFileSync(join(f.local, ".gitignore"), "ignored.log\ntarget/\n");
      const first = hostRun(f, f.local, ["--mode=exclusive", "--label=cold", "--", "sh", "-c",
        "mkdir -p target && echo built > target/cache.txt && echo stray > stray.txt && echo scribble >> notes.txt"]);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stderr).toContain("(cold: no build cache yet)");
      writeFileSync(join(f.local, "notes.txt"), "committed\nsecond edit\n");
      const second = hostRun(f, f.local, ["--mode=exclusive", "--label=warm", "--", "sh", "-c",
        "cat target/cache.txt; test -e stray.txt && echo stray-left; cat notes.txt; test -e gone.txt || echo gone-deleted"]);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stderr).not.toContain("cold");
      expect(second.stdout).toBe("built\ncommitted\nsecond edit\ngone-deleted\n");
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  computeHost("never shares a workspace: one slot serializes runs, two slots run side by side, idle slots are evicted under disk pressure", async () => {
    const f = fixture();
    try {
      const busy = join(f.root, "busy");
      const probe = `if [ -e ${busy} ]; then echo OVERLAP; fi; touch ${busy}; sleep 2; rm -f ${busy}; pwd`;
      type Run = { code: number | null; stdout: string; stderr: string };
      const start = (): Promise<Run> => new Promise((resolveRun) => {
        const child = spawn(process.execPath, [hostRunScript, "--mode=heavy", "--label=pair", "--", "sh", "-c", probe],
          { cwd: f.local, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("exit", (code) => resolveRun({ code, stderr, stdout }));
      });
      computeConfig(f, { slots: 1 });
      const serial = await Promise.all([start(), start()]);
      for (const run of serial) expect(run.code, run.stderr).toBe(0);
      expect(serial.map((run) => run.stdout).join("")).not.toContain("OVERLAP");
      expect(serial.map((run) => run.stderr).join("")).toContain("cached workspaces for github.com-test-proj are in use; waiting");

      computeConfig(f, { slots: 2 });
      const parallel = await Promise.all([start(), start()]);
      for (const run of parallel) expect(run.code, run.stderr).toBe(0);
      expect(new Set(parallel.map((run) => run.stdout.trim().split("\n").at(-1))))
        .toEqual(new Set([join(workspaceRoot(f), "slot-1", "tree"), join(workspaceRoot(f), "slot-2", "tree")]));

      computeConfig(f, { slots: 2, minFreeGiB: 4096 });
      const pressured = hostRun(f, f.local, ["--mode=heavy", "--label=pressure", "--", "true"]);
      expect(pressured.status, pressured.stderr).toBe(0);
      expect(pressured.stderr).toContain("evicted the cached workspace github.com-test-proj/slot-2");
      expect(existsSync(join(workspaceRoot(f), "slot-2"))).toBe(false);
      expect(existsSync(join(workspaceRoot(f), "slot-1", "tree"))).toBe(true);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 180_000);

  computeHost("runs here, with one line saying why, when forwarding cannot start; --local and shared mode never forward", () => {
    const f = fixture();
    try {
      computeConfig(f);
      const where = ["sh", "-c", "echo forwarded=${LOCAL_EFFICIENCY_FORWARDED:-0}"];
      const down = hostRun(f, f.local, ["--mode=heavy", "--label=down", "--", ...where], { FAKE_SSH_FAIL: "1" });
      expect(down.status, down.stderr).toBe(0);
      expect(down.stdout).toContain("forwarded=0");
      expect(down.stderr).toContain("[host-run] running down on this Mac: cannot reach fakehost over ssh");
      const notRepo = hostRun(f, f.root, ["--mode=heavy", "--label=plain", "--", ...where]);
      expect(notRepo.status, notRepo.stderr).toBe(0);
      expect(notRepo.stderr).toContain("running plain on this Mac: compute forwarding needs a Git repository");
      // The remote cannot prepare the run (this directory holds only ignored files): nothing ran there.
      mkdirSync(join(f.local, "logs"));
      writeFileSync(join(f.local, "logs", "ignored.log"), "x\n");
      const unprepared = hostRun(f, join(f.local, "logs"), ["--mode=heavy", "--label=logs", "--", ...where]);
      expect(unprepared.status, unprepared.stderr).toBe(0);
      expect(unprepared.stdout).toContain("forwarded=0");
      expect(unprepared.stderr).toContain("running logs on this Mac: fakehost could not prepare the run: working directory logs does not exist");
      for (const args of [["--mode=heavy", "--local"], ["--mode=shared"]]) {
        const local = hostRun(f, f.local, [...args, "--label=here", "--", ...where], { FAKE_SSH_FAIL: "1" });
        expect(local.status, local.stderr).toBe(0);
        expect(local.stdout).toContain("forwarded=0");
        expect(local.stderr).not.toContain("fakehost");
      }
      computeConfig(f, { modes: ["exclusive"] });
      const heavyNotListed = hostRun(f, f.local, ["--mode=heavy", "--label=here", "--", ...where], { FAKE_SSH_FAIL: "1" });
      expect(heavyNotListed.stderr).not.toContain("fakehost");
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  test("--local and --remote apply to compute and mac-ui only, and not together", () => {
    expect(parseHostRunArguments(["--mode=heavy", "--local", "--", "cargo", "build"])).toMatchObject({ local: true, lane: "compute" });
    expect(parseHostRunArguments(["--lane=mac-ui", "--local", "--", "true"])).toMatchObject({ local: true, lane: "mac-ui" });
    expect(parseHostRunArguments(["--lane=mac-ui", "--remote", "--", "true"])).toMatchObject({ remote: true, lane: "mac-ui" });
    expect(() => parseHostRunArguments(["--lane=browser", "--local", "--", "true"])).toThrow("only valid with --lane=compute or --lane=mac-ui");
    expect(() => parseHostRunArguments(["--lane=mac-native", "--remote", "--", "true"])).toThrow("only valid with --lane=compute or --lane=mac-ui");
    expect(() => parseHostRunArguments(["--local", "--remote", "--", "true"])).toThrow("cannot be combined");
    expect(() => parseHostRunArguments(["--local", "--local", "--", "true"])).toThrow("only once");
    expect(() => parseHostRunArguments(["--remote", "--remote", "--", "true"])).toThrow("only once");
  });
});

/** Refs, config, worktree and loose and packed object counts of a remote ~/src clone. */
function cloneState(clone: string): string {
  return sh(clone, "git for-each-ref --format='%(refname) %(objectname)'; git config --list --local; git status --porcelain; ls .git/objects/pack | sort; git count-objects");
}

describe("forwarding to a partial clone (blob-less, origin unreachable)", () => {
  remoteMac("mac-ui: sends the blobs the clone lacks into host-run's object store once, never into ~/src", () => {
    const f = fixture({ remoteClone: "partial" });
    try {
      const fill = join(f.remoteHome, ".local", "state", "host-run", "fill", "proj");
      expect(sh(f.remoteClone, "git rev-list --objects --missing=print HEAD | grep -c '^?'")).toBe("3");
      const before = cloneState(f.remoteClone);
      // Patch preimages (notes.txt, gone.txt) and an untouched file (sub/keep.txt) are all missing there.
      const command = ["sh", "-c", "cat ../notes.txt ../sub/keep.txt; test -e ../gone.txt || echo gone-deleted"];
      const first = hostRun(f, join(f.local, "sub"), ["--lane=mac-ui", "--label=partial", "--", ...command]);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toBe("committed\nplus a local edit\nsub\ngone-deleted\n");
      expect(first.stderr).toMatch(/fakehost's clone of github\.com\/test\/proj is a partial clone without 3 objects that [0-9a-f]{12} needs; sending them \(\d+ KiB\)/u);
      expect(existsSync(join(fill, "objects", "pack"))).toBe(true);
      expect(cloneState(f.remoteClone)).toBe(before);
      expect(remoteRuns(f)).toEqual([]);
      // The fill store already has them: nothing is sent again.
      const second = hostRun(f, join(f.local, "sub"), ["--lane=mac-ui", "--label=partial", "--", ...command]);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toBe(first.stdout);
      expect(second.stderr).not.toContain("partial clone without");
      expect(cloneState(f.remoteClone)).toBe(before);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  computeHost("compute: the cached workspace gets the same objects and stays usable", () => {
    const f = fixture({ remoteClone: "partial" });
    try {
      computeConfig(f);
      const before = cloneState(f.remoteClone);
      const first = hostRun(f, f.local, ["--mode=heavy", "--label=partial-build", "--", "sh", "-c", "cat notes.txt sub/keep.txt"]);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain("plus a local edit\nsub\n");
      expect(first.stderr).toContain("is a partial clone without 3 objects");
      writeFileSync(join(f.local, "sub", "keep.txt"), "sub edited\n");
      const second = hostRun(f, f.local, ["--mode=heavy", "--label=partial-build", "--", "sh", "-c", "cat sub/keep.txt"]);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("sub edited\n");
      expect(second.stderr).not.toContain("partial clone without");
      expect(cloneState(f.remoteClone)).toBe(before);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  remoteMac("the remote names a checkout that left files out instead of failing later on the patch", () => {
    const f = fixture({ remoteClone: "partial" });
    try {
      // An older workstation sends no objects: the remote must still say why.
      const payload = join(f.root, "payload");
      mkdirSync(payload);
      writeFileSync(join(payload, "patch"), "");
      sh(f.root, `tar -cf payload.tar -C ${payload} .`);
      const sha = sh(f.remoteClone, "git rev-parse HEAD");
      const result = spawnSync("/bin/bash", [remoteScriptPath, "run", "guard-1", f.remoteClone, sha, "", "direct", "0", "60", "true", "--"], {
        encoding: "utf8",
        env: { ...f.env, HOME: f.remoteHome },
        input: readFileSync(join(f.root, "payload.tar")),
        timeout: 60_000,
      });
      expect(result.status).toBe(forwardUnavailableExitCode);
      expect(result.stderr).toContain(`checking out ${sha} left 3 tracked files out`);
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  remoteMac("with sending turned off, it stops with a clear reason instead of a patch failure", () => {
    const f = fixture({ remoteClone: "partial", config: { macUi: { forwardTo: "fakehost", remoteHostRun: hostRunScript, seedMaxMiB: 0 } } });
    try {
      const result = hostRun(f, f.local, ["--lane=mac-ui", "--label=partial-off", "--", "true"]);
      expect(result.status).toBe(forwardUnavailableExitCode);
      expect(result.stderr).toContain("is a partial clone without 3 objects");
      expect(result.stderr).toContain("sending objects is off (seedMaxMiB is 0");
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);
});

/** The payload host-run sends for the local HEAD, from the real planner and packer. */
function forwardedPayload(f: Fixture, adjust: (plan: ForwardPlan) => ForwardPlan = (plan) => plan): Buffer {
  const deps: ForwardDependencies = { ...defaultForwardDependencies(f.env), log: () => {} };
  const config = { forwardTo: "fakehost", remoteHostRun: hostRunScript, source: join(f.env.XDG_CONFIG_HOME!, "host-run", "remote.json") };
  const plan = adjust(planForward(deps, config, readFileSync(remoteScriptPath, "utf8"), f.local));
  const scratch = mkdtempSync(join(f.root, "scratch-"));
  buildPayload(deps, plan, scratch, config);
  return readFileSync(join(scratch, "payload.tar"));
}

/** The commits.pack inside a payload. */
function commitPackOf(f: Fixture, payload: Buffer): Buffer {
  const directory = mkdtempSync(join(f.root, "unpacked-"));
  const untar = spawnSync("tar", ["-xf", "-", "-C", directory], { input: payload });
  if (untar.status !== 0) throw new Error(`tar: ${untar.stderr}`);
  return readFileSync(join(directory, "commits.pack"));
}

/** Indexes a pack in an empty repository, where a thin pack cannot be completed. */
function indexAlone(f: Fixture, pack: Buffer) {
  const repository = mkdtempSync(join(f.root, "alone-"));
  sh(repository, "git init --quiet --bare .");
  const indexed = spawnSync("git", ["index-pack", "--stdin"], { cwd: repository, encoding: "utf8", input: pack });
  return {
    has: (id: string) => spawnSync("git", ["cat-file", "-e", id], { cwd: repository }).status === 0,
    status: indexed.status,
    stderr: indexed.stderr,
  };
}

/** Runs `mac-ui-remote.sh run` here as ssh would on the remote Mac (direct launcher), with `sh -c SCRIPT` as the command. */
function runRemoteHalf(f: Fixture, payload: Buffer, sha: string, script: string) {
  return spawnSync("/bin/bash", [remoteScriptPath, "run", `direct-${process.pid}`, f.remoteClone, sha, "", "direct", "0", "60", "/bin/sh", "--", "-c", script], {
    encoding: "utf8",
    env: { ...f.env, HOME: f.remoteHome },
    input: payload,
    timeout: 60_000,
  });
}

// HRA2 on 2026-11-26: its ~/src clone is a blob-less partial clone that got a
// pull request's commits through `git fetch origin <branch>` (FETCH_HEAD only)
// for a detached worktree. host-run asked which commits it has, built on them,
// and `git bundle unbundle` refused: "some prerequisite commits exist in the
// object store, but are not connected to the repository's history".
describe("forwarding commits built on ones the remote clone has but no ref reaches", () => {
  remoteMac("mac-ui: runs at the local HEAD", () => {
    const f = fixture({ remoteClone: "partial", pullRequest: true });
    try {
      const pullRequest = sh(f.local, "git rev-parse origin/pr");
      expect(sh(f.remoteClone, `git cat-file -t ${pullRequest}`)).toBe("commit");
      expect(sh(f.remoteClone, `git for-each-ref --contains ${pullRequest}`)).toBe("");
      const before = cloneState(f.remoteClone);
      const result = hostRun(f, f.local, ["--lane=mac-ui", "--label=pr", "--", "sh", "-c", "git rev-parse HEAD; tail -n 1 x.txt; cat later.txt notes.txt"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${sh(f.local, "git rev-parse HEAD")}\na pull request line\na commit the remote clone lacks\ncommitted\nplus a local edit\n`);
      expect(result.stderr).toContain(" + 1 commit,");
      expect(result.stderr).not.toContain("partial clone without");
      expect(cloneState(f.remoteClone)).toBe(before);
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  computeHost("compute: runs in the cached workspace instead of falling back to this Mac", () => {
    const f = fixture({ remoteClone: "partial", pullRequest: true });
    try {
      computeConfig(f);
      const result = hostRun(f, f.local, ["--mode=heavy", "--label=pr-build", "--", "sh", "-c",
        "echo forwarded=${LOCAL_EFFICIENCY_FORWARDED:-0}; pwd; tail -n 1 x.txt"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("on this Mac");
      expect(result.stdout).toContain(`forwarded=1\n${join(workspaceRoot(f), "slot-1", "tree")}\na pull request line\n`);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  computeHost("mac-ui-remote.sh applies the payload in a throwaway tree and leaves the clone alone", () => {
    const f = fixture({ remoteClone: "partial", pullRequest: true });
    try {
      const head = sh(f.local, "git rev-parse HEAD");
      const before = cloneState(f.remoteClone);
      const result = runRemoteHalf(f, forwardedPayload(f), head, "git rev-parse HEAD; tail -n 1 x.txt; cat later.txt");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${head}\na pull request line\na commit the remote clone lacks\n`);
      expect(cloneState(f.remoteClone)).toBe(before);
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  computeHost("mac-ui-remote.sh stops with 69 and names the commit when one they build on is gone", () => {
    const f = fixture();
    try {
      const later = sh(f.local, "git rev-parse HEAD");
      sh(f.local, "git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit --quiet --allow-empty -m after-later");
      // As if the clone had `later` when host-run asked and lost it (pruned) before the run.
      const payload = forwardedPayload(f, (plan) => ({ ...plan, haves: [later] }));
      const result = runRemoteHalf(f, payload, sh(f.local, "git rev-parse HEAD"), "echo ran");
      expect(result.status, result.stderr).toBe(forwardUnavailableExitCode);
      expect(result.stdout).not.toContain("ran");
      expect(result.stderr).toContain(`the forwarded commits build on ${later}, which ${f.remoteClone} on `);
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  computeHost("mac-ui-remote.sh takes only full commit names, SHA-1 or SHA-256", () => {
    const f = fixture();
    try {
      const head = sh(f.remoteClone, "git rev-parse HEAD");
      const payload = (prerequisites: string): Buffer => {
        const directory = mkdtempSync(join(f.root, "payload-"));
        writeFileSync(join(directory, "patch"), "");
        if (prerequisites !== "") writeFileSync(join(directory, "prerequisites"), prerequisites);
        sh(directory, "tar -cf ../payload.tar .");
        return readFileSync(join(f.root, "payload.tar"));
      };
      for (const sha of [head.slice(0, 12), `${head}0`, head.toUpperCase(), "a".repeat(63)]) {
        const result = runRemoteHalf(f, payload(""), sha, "echo ran");
        expect(result.status).toBe(forwardUnavailableExitCode);
        expect(result.stderr).toContain(`invalid commit: ${sha}`);
      }
      // A 64-digit name passes the check and is then looked for.
      const sha256 = runRemoteHalf(f, payload(""), "a".repeat(64), "echo ran");
      expect(sha256.status).toBe(forwardUnavailableExitCode);
      expect(sha256.stderr).toContain(`commit ${"a".repeat(64)} is not available`);
      const short = runRemoteHalf(f, payload(`${head.slice(0, 39)}\n`), head, "echo ran");
      expect(short.status).toBe(forwardUnavailableExitCode);
      expect(short.stdout).not.toContain("ran");
      expect(short.stderr).toContain(`invalid prerequisite commit in the forwarded payload: ${head.slice(0, 39)}`);
      expect(runRemoteHalf(f, payload(`${head}\n`), head, "echo ran").stdout).toBe("ran\n");
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);
});

describe("forwarding to a partial clone a file it has only an older version of", () => {
  // A bundle's pack is thin: a changed file can travel as a delta against the
  // version in the clone's commit, which a blob-less clone never fetched.
  computeHost("the changed file travels whole and the run happens on the remote", () => {
    const f = fixture({ remoteClone: "partial", bigFile: true });
    try {
      computeConfig(f);
      const result = hostRun(f, f.local, ["--mode=heavy", "--label=big", "--", "sh", "-c",
        "echo forwarded=${LOCAL_EFFICIENCY_FORWARDED:-0}; tail -n 1 big.txt"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("on this Mac");
      expect(result.stderr).toContain("is a partial clone without 3 objects");
      expect(result.stdout).toContain("forwarded=1\none more line\n");
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);
});

describe("the commit pack is thin for a full clone and self-contained for a partial one", () => {
  // A one-line change to a large file packs to a few hundred bytes thin and
  // to the whole compressed file otherwise, so a full clone, which has every
  // file of the commits the new ones build on, gets the thin pack.
  computeHost("full clone: a changed file travels as a delta, and the remote completes the pack from the clone", () => {
    const f = fixture({ bigFile: true });
    try {
      const head = sh(f.local, "git rev-parse HEAD");
      const payload = forwardedPayload(f);
      const thin = commitPackOf(f, payload);
      const alone = indexAlone(f, thin);
      expect(alone.status).not.toBe(0);
      expect(alone.stderr).toContain("unresolved delta");
      const whole = commitPackOf(f, forwardedPayload(f, (plan) => ({ ...plan, partial: true })));
      expect(indexAlone(f, whole).status).toBe(0);
      expect(thin.length).toBeLessThan(whole.length / 2);
      const before = cloneState(f.remoteClone);
      const result = runRemoteHalf(f, payload, head, "git rev-parse HEAD; tail -n 1 big.txt; cat later.txt");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${head}\none more line\na commit the remote clone lacks\n`);
      expect(cloneState(f.remoteClone)).toBe(before);
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  computeHost("partial clone: the changed file travels whole, since the clone lacks the version a delta needs", () => {
    const f = fixture({ remoteClone: "partial", bigFile: true });
    try {
      const head = sh(f.local, "git rev-parse HEAD");
      const payload = forwardedPayload(f);
      const alone = indexAlone(f, commitPackOf(f, payload));
      expect(alone.status, alone.stderr).toBe(0);
      expect(alone.has(sh(f.local, "git rev-parse HEAD:big.txt"))).toBe(true);
      const result = runRemoteHalf(f, payload, head, "tail -n 1 big.txt");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("one more line\n");
      // A thin pack could not be completed there, and the remote says so.
      const thin = runRemoteHalf(f, forwardedPayload(f, (plan) => ({ ...plan, partial: false })), head, "echo ran");
      expect(thin.status).toBe(forwardUnavailableExitCode);
      expect(thin.stdout).not.toContain("ran");
      expect(thin.stderr).toMatch(/could not add the forwarded commits: .*unresolved delta/u);
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  // With a reachability bitmap, pack-objects leaves out everything a commit
  // the remote has reaches, here origin/main's fix.txt, though the commit the
  // sent ones build on lacks it. The objects sent to a partial clone leave out
  // what the commit pack should carry, so fix.txt would travel in neither.
  computeHost("partial clone: a local bitmap does not keep a cherry-picked fix out of both packs", () => {
    const f = fixture({ remoteClone: "partial", cherryPick: true });
    try {
      sh(f.local, "git repack -a -d -b -q");
      expect(readdirSync(join(f.local, ".git", "objects", "pack")).some((name) => name.endsWith(".bitmap"))).toBe(true);
      const fix = sh(f.local, "git rev-parse HEAD:fix.txt");
      expect(sh(f.local, "git rev-parse origin/main:fix.txt")).toBe(fix);
      // What pack-objects packs when it may use the bitmap.
      const bitmapped = spawnSync("git", ["pack-objects", "--revs", "--stdout", "-q"], {
        cwd: f.local,
        input: "HEAD\n^origin/main\n^origin/older\n",
      });
      expect(bitmapped.status).toBe(0);
      expect(indexAlone(f, bitmapped.stdout).has(fix)).toBe(false);
      const payload = forwardedPayload(f);
      expect(indexAlone(f, commitPackOf(f, payload)).has(fix)).toBe(true);
      const result = runRemoteHalf(f, payload, sh(f.local, "git rev-parse HEAD"), "cat fix.txt later.txt");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("a fix made on main\na commit the remote clone lacks\n");
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);
});

function presenceConfig(f: Fixture, facts: object, extra: object = {}): NodeJS.ProcessEnv {
  writeFileSync(join(f.env.XDG_CONFIG_HOME!, "host-run", "remote.json"), JSON.stringify({
    compute: { forwardTo: "fakehost", remoteHostRun: hostRunScript },
    macUi: { forwardTo: "fakehost", remoteHostRun: hostRunScript },
    presence: { graceSeconds: 1, ...extra },
  }));
  const path = join(f.root, "presence.json");
  writeFileSync(path, JSON.stringify(facts));
  return {
    LOCAL_EFFICIENCY_PRESENCE_FIXTURE: path,
    LOCAL_EFFICIENCY_PRESENCE_POLL_MS: "100",
    LOCAL_EFFICIENCY_PRESENCE_RETRY_MS: "300",
  };
}

function setFacts(f: Fixture, facts: object): void {
  writeFileSync(join(f.root, "presence.json"), JSON.stringify(facts));
}

type Running = { code: Promise<number | null>; stderr: () => string; stdout: () => string };

function startHostRun(f: Fixture, args: readonly string[], extraEnv: NodeJS.ProcessEnv): Running {
  const child = spawn(process.execPath, [hostRunScript, ...args], {
    cwd: f.local,
    env: { ...f.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return {
    code: new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code))),
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(50);
}

const where = ["sh", "-c", "echo forwarded=${LOCAL_EFFICIENCY_FORWARDED:-0}"];
const typing = { keyIdleSeconds: 30 };

// UI runs here need the mac-ui lane, which only exists on macOS.
describe("presence-aware placement (fixture presence, fake ssh)", () => {
  remoteMac("UI work runs here while the owner is idle and goes to the other Mac otherwise; --local and --remote override", () => {
    const f = fixture();
    try {
      const env = presenceConfig(f, {});
      const here = hostRun(f, f.local, ["--lane=mac-ui", "--label=ui", "--", ...where], env);
      expect(here.status, here.stderr).toBe(0);
      expect(here.stdout).toContain("forwarded=0");
      expect(here.stderr).toMatch(/\[host-run\] placing ui on \S+: owner idle 1h00m, no video or call\n/u);
      for (const [facts, reason] of [
        [typing, "typed 30s ago"],
        [{ video: [{ name: "Video Wake Lock", pid: 1, process: "IINA" }] }, "video playing in IINA"],
        [{ camera: true }, "camera in use"],
        [{ locked: true }, "screen locked; UI tests need an unlocked, awake screen"],
      ] as const) {
        setFacts(f, facts);
        const away = hostRun(f, f.local, ["--lane=mac-ui", "--label=ui", "--", ...where], env);
        expect(away.status, away.stderr).toBe(0);
        expect(away.stdout).toContain("forwarded=1");
        expect(away.stderr).toContain(`[host-run] placing ui on fakehost: ${reason}`);
      }
      const local = hostRun(f, f.local, ["--lane=mac-ui", "--local", "--label=ui", "--", ...where], env);
      expect(local.stdout, local.stderr).toContain("forwarded=0");
      expect(local.stderr).toContain(": --local");
      setFacts(f, {});
      const remote = hostRun(f, f.local, ["--lane=mac-ui", "--remote", "--label=ui", "--", ...where], env);
      expect(remote.stdout, remote.stderr).toContain("forwarded=1");
      expect(remote.stderr).toContain("placing ui on fakehost: --remote");
      expect(remoteRuns(f)).toEqual([]);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 180_000);

  remoteMac("a UI run here stops when the owner starts typing and reruns on the other Mac", async () => {
    const f = fixture();
    try {
      const env = presenceConfig(f, {});
      const tag = `hostrun-handoff-${process.pid}-${Date.now()}`;
      const run = startHostRun(f, ["--lane=mac-ui", "--label=handoff", "--", "sh", "-c",
        `if [ "$LOCAL_EFFICIENCY_FORWARDED" = 1 ]; then echo ran-remotely; else echo ran-here; exec -a ${tag} sleep 60; fi`], env);
      await waitFor(() => run.stdout().includes("ran-here"));
      expect(run.stdout(), run.stderr()).toContain("ran-here");
      setFacts(f, typing);
      const code = await run.code;
      expect(code, run.stderr()).toBe(0);
      expect(run.stdout()).toContain("ran-remotely");
      expect(run.stderr()).toContain("[host-run] typed 30s ago: stopping this run here (TERM, then KILL after 1s)");
      expect(run.stderr()).toMatch(/handoff stopped on \S+ \(typed 30s ago\)[^\n]*; rerunning it on fakehost/u);
      expect(spawnSync("pgrep", ["-f", tag]).status).toBe(1);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);

  remoteMac("with the other Mac unreachable, a busy owner means waiting: it runs here once they go idle, else gives up", async () => {
    const f = fixture();
    try {
      const env = { ...presenceConfig(f, typing), FAKE_SSH_FAIL: "1", LOCAL_EFFICIENCY_PRESENCE_WAIT_MS: "60000" };
      const run = startHostRun(f, ["--lane=mac-ui", "--label=wait", "--", ...where], env);
      await waitFor(() => run.stderr().includes("waiting up to"));
      expect(run.stdout()).toBe("");
      setFacts(f, {});
      expect(await run.code, run.stderr()).toBe(0);
      expect(run.stdout()).toContain("forwarded=0");
      expect(run.stderr()).toContain("cannot reach fakehost over ssh");
      expect(run.stderr()).toMatch(/placing wait on \S+: owner idle/u);

      setFacts(f, typing);
      const marker = join(f.root, "ran");
      const gaveUp = hostRun(f, f.local, ["--lane=mac-ui", "--label=wait", "--", "touch", marker],
        { ...env, LOCAL_EFFICIENCY_PRESENCE_WAIT_MS: "1000" });
      expect(gaveUp.status, gaveUp.stderr).toBe(forwardUnavailableExitCode);
      expect(gaveUp.stderr).toContain("wait did not run: the owner stayed busy here (typed 30s ago) and fakehost stayed unreachable");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);
});

describe("presence-aware heavy compute (fixture presence, fake ssh)", () => {
  computeHost("goes to the other Mac while the owner is busy or this Mac is short of room, stays here otherwise", () => {
    const f = fixture();
    try {
      const env = presenceConfig(f, typing);
      const cases: [object, string, string][] = [
        [typing, "forwarded=1", "placing build on fakehost: typed 30s ago"],
        [{ load: { local: 0.1, remote: 0.9 } }, "forwarded=0", "owner idle 1h00m, no video or call; load 0.1/core here, 0.9/core on fakehost"],
        [{ load: { local: 2, remote: 0.5 } }, "forwarded=1", "placing build on fakehost: owner idle 1h00m, no video or call, but fakehost is less loaded"],
        [{ load: { localFreePermits: 0, remote: 2 } }, "forwarded=1", "permits it needs are free here"],
        [{ locked: true, load: { local: 0.1, remote: null } }, "forwarded=0", "owner away (screen locked); fakehost did not report its load"],
      ];
      for (const [facts, expected, line] of cases) {
        setFacts(f, facts);
        const result = hostRun(f, f.local, ["--mode=heavy", "--label=build", "--", ...where], env);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(expected);
        expect(result.stderr).toContain(line);
      }
      // The other Mac reports its real load when the fixture leaves it out.
      setFacts(f, { load: { local: 0 } });
      const measured = hostRun(f, f.local, ["--mode=heavy", "--label=build", "--", ...where], env);
      expect(measured.stderr).toMatch(/load 0\.0\/core here, [0-9.]+\/core on fakehost/u);
      // --remote never runs here.
      const marker = join(f.root, "ran");
      const remoteDown = hostRun(f, f.local, ["--mode=heavy", "--remote", "--label=build", "--", "touch", marker],
        { ...env, FAKE_SSH_FAIL: "1" });
      expect(remoteDown.status, remoteDown.stderr).toBe(forwardUnavailableExitCode);
      expect(remoteDown.stderr).toContain("build was not forwarded: cannot reach fakehost");
      expect(existsSync(marker)).toBe(false);
      // Busy owner, unreachable remote: it runs here rather than not at all.
      setFacts(f, typing);
      const fallback = hostRun(f, f.local, ["--mode=heavy", "--label=build", "--", ...where], { ...env, FAKE_SSH_FAIL: "1" });
      expect(fallback.stdout, fallback.stderr).toContain("forwarded=0");
      expect(fallback.stderr).toContain("running build on this Mac: cannot reach fakehost");
      expect(fallback.stderr).toContain("build continues at background priority");
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 180_000);

  remoteMac("a build here moves to background priority while the owner is busy and back when they stop", async () => {
    const f = fixture();
    try {
      const env = presenceConfig(f, typing);
      const report = join(f.root, "priority");
      const run = startHostRun(f, ["--mode=heavy", "--local", "--label=build", "--", "sh", "-c",
        `sleep 1; ps -o pri= -p $$ > ${report}.tmp && mv ${report}.tmp ${report}.busy; while [ ! -e ${report}.go ]; do sleep 0.1; done; sleep 1; ps -o pri= -p $$ > ${report}.idle`], env);
      await waitFor(() => existsSync(`${report}.busy`));
      expect(run.stderr()).toContain("owner is busy (typed 30s ago); build continues at background priority");
      setFacts(f, {});
      await waitFor(() => run.stderr().includes("back at normal priority"));
      writeFileSync(`${report}.go`, "");
      expect(await run.code, run.stderr()).toBe(0);
      const busy = Number(readFileSync(`${report}.busy`, "utf8"));
      const normal = Number(readFileSync(`${report}.idle`, "utf8"));
      expect(busy, run.stderr()).toBeLessThan(10);
      // A child cannot rise above the priority it inherits. When this whole
      // suite already runs at background priority (an outer host-run while the
      // owner is busy), the log line above is all the run can show.
      const inherited = Number(Bun.spawnSync(["sh", "-c", "ps -o pri= -p $$"]).stdout.toString());
      if (inherited >= 10) expect(normal).toBeGreaterThan(busy);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }, 120_000);
});
