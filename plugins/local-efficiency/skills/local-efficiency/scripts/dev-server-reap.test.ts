import { describe, expect, test } from "bun:test";

import {
  agentBrowserBinary,
  chromeTargetPorts,
  chromeUserDataDirectory,
  classify,
  formatReport,
  isChromeRoot,
  listenerKind,
  parseCwds,
  parseElapsed,
  parseListeners,
  parsePs,
  type ProcessInfo,
  type Snapshot,
} from "./dev-server-reap";

const hour = 3_600;
const scratch = "/private/tmp/agent-sessions/p/s/scratchpad/wt";

function processInfo(pid: number, ppid: number, ageSeconds: number, command: string): ProcessInfo {
  return { ageSeconds, command, pid, ppid, rssKilobytes: 150 * 1024 };
}

function snapshot(overrides: Partial<Snapshot>): Snapshot {
  return {
    cwds: new Map(),
    exists: () => true,
    holderPids: new Set(),
    home: "/tmp/le-fixture/user",
    listeners: [],
    portLeases: [],
    processes: [],
    ...overrides,
  };
}

describe("dev-server-reap parsing", () => {
  test("parses ps elapsed times and rows", () => {
    expect(parseElapsed("05:07")).toBe(307);
    expect(parseElapsed("08:08:07")).toBe(8 * hour + 8 * 60 + 7);
    expect(parseElapsed("2-01:00:00")).toBe(2 * 86_400 + hour);
    expect(parseElapsed("garbage")).toBe(0);
    expect(parsePs("  5813     1 08:53:00 176128 next-server (v16.0.0)\n")).toEqual([
      { ageSeconds: 8 * hour + 53 * 60, command: "next-server (v16.0.0)", pid: 5813, ppid: 1, rssKilobytes: 176128 },
    ]);
  });

  test("parses lsof listener and cwd field output", () => {
    expect(parseListeners("p5813\nf23\nn*:3107\nf24\nn[::1]:3107\np799\nf3\nn127.0.0.1:11434\n")).toEqual([
      { addresses: ["*:3107", "[::1]:3107"], pid: 5813, ports: [3107] },
      { addresses: ["127.0.0.1:11434"], pid: 799, ports: [11434] },
    ]);
    expect(parseCwds("p5813\nfcwd\nn/tmp/gone\np799\nfcwd\nn/\n")).toEqual(new Map([[5813, "/tmp/gone"], [799, "/"]]));
  });

  test("classifies listener and Chrome commands", () => {
    expect(listenerKind("next-server (v16.0.0)")).toBe("next-server");
    expect(listenerKind("/usr/bin/python3 -m http.server 4329")).toBe("python-http-server");
    expect(listenerKind("bun run dev")).toBe("js-server");
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --user-data-dir=/private/tmp/a b/prof-d --window-size=1440,1600 http://localhost:8741/";
    expect(isChromeRoot(chrome)).toBe(true);
    expect(isChromeRoot("/Applications/Google Chrome.app/Contents/Frameworks/x/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process")).toBe(false);
    expect(chromeUserDataDirectory(chrome)).toBe("/private/tmp/a b/prof-d");
    expect(chromeTargetPorts(chrome)).toEqual([8741]);
  });

  test("finds agent-browser by absolute path", () => {
    expect(agentBrowserBinary({ AGENT_BROWSER_BIN: import.meta.path }, "/nonexistent")).toBe(import.meta.path);
  });
});

describe("dev-server-reap classification (report only)", () => {
  test("flags orphan dev servers with a deleted cwd or an unleased 4h age", () => {
    const report = classify(snapshot({
      cwds: new Map([
        [10, `${scratch}/roughday`],
        [11, `${scratch}/soulscrape/site`],
        [12, "/w/leased"],
        [13, "/w/young"],
        [14, "/w/child"],
        [15, "/"],
        [16, "/opt/homebrew/var"],
        [17, "/w/hostrun"],
      ]),
      exists: (path) => !path.endsWith("/roughday"),
      holderPids: new Set([30]),
      listeners: [10, 11, 12, 13, 14, 15, 16, 17].map((pid) => ({ addresses: [`*:${4000 + pid}`], pid, ports: [4000 + pid] })),
      portLeases: [{
        createdAt: new Date().toISOString(),
        name: "web",
        port: 4012,
        renewedAt: new Date().toISOString(),
        requesterPid: 1,
        version: 1,
        worktree: "/w/leased",
      }],
      processes: [
        processInfo(10, 1, 1 * hour, "next-server (v16)"),
        processInfo(11, 1, 9 * hour, "next-server (v16)"),
        processInfo(12, 1, 9 * hour, "next-server (v16)"),
        processInfo(13, 1, 1 * hour, "next-server (v16)"),
        processInfo(14, 99, 9 * hour, "next-server (v16)"),
        processInfo(15, 1, 9 * hour, "/usr/local/bin/some-daemon"),
        processInfo(16, 1, 9 * hour, "/opt/homebrew/opt/ollama/bin/ollama serve"),
        processInfo(17, 1, 9 * hour, "python3 -m http.server 4017"),
        processInfo(30, 1, 9 * hour, "bun host-run --lane=browser"),
      ],
    }));
    expect(report.listeners.map((entry) => [entry.pid, entry.reason])).toEqual([
      [11, "older than 4h without a host-run holder or hra-port lease"],
      [17, "older than 4h without a host-run holder or hra-port lease"],
      [10, "cwd deleted"],
    ]);
  });

  test("treats a listener under a host-run holder as leased", () => {
    const report = classify(snapshot({
      cwds: new Map([[41, "/w/preview"]]),
      holderPids: new Set([40]),
      listeners: [{ addresses: ["127.0.0.1:4329"], pid: 41, ports: [4329] }],
      processes: [processInfo(40, 1, 9 * hour, "bun host-run"), processInfo(41, 40, 9 * hour, "python3 -m http.server 4329")],
    }));
    expect(report.listeners).toEqual([]);
  });

  test("flags orphan headless Chrome but never the real profile", () => {
    const chrome = (profile: string, extra = ""): string =>
      `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new ${profile}${extra}`;
    const report = classify(snapshot({
      listeners: [{ addresses: ["127.0.0.1:3000"], pid: 90, ports: [3000] }],
      processes: [
        processInfo(50, 1, 8 * hour, chrome("--user-data-dir=/private/tmp/x/prof-d", " http://localhost:8741/")),
        processInfo(51, 1, 20 * 60, chrome("--user-data-dir=/private/tmp/x/prof-e", " http://127.0.0.1:3000/")),
        processInfo(52, 1, 3 * hour, chrome("--user-data-dir=/var/folders/ab/T/agent-browser-chrome-1")),
        processInfo(53, 1, 30 * hour, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        processInfo(54, 1, 30 * hour, chrome("--user-data-dir=/tmp/le-fixture/user/Library/Application Support/Google/Chrome")),
        processInfo(55, 77, 30 * hour, chrome("--user-data-dir=/private/tmp/x/owned")),
        processInfo(56, 1, 30 * 60, chrome("--user-data-dir=/private/tmp/x/shot", " --screenshot=/tmp/a.png")),
      ],
    }));
    expect(report.chrome.map((entry) => [entry.pid, entry.reason])).toEqual([
      [50, "target port 8741 not listening"],
      [52, "older than 2h"],
      [56, "one-shot --screenshot still running after 10m"],
    ]);
  });

  test("lists Next telemetry flush leftovers and summarizes idle runtimes", () => {
    const report = classify(snapshot({
      processes: [
        processInfo(60, 1, 8 * hour, "node /w/node_modules/next/dist/telemetry/detached-flush.js dev /w"),
        processInfo(61, 80831, 13 * hour, "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"),
        processInfo(62, 80831, 1 * hour, "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"),
        processInfo(63, 500, 5 * hour, "codex resume 0199"),
        processInfo(64, 500, 13 * hour, "/tmp/le-fixture/user/.local/bin/devin"),
        processInfo(65, 64, 13 * hour, "/tmp/le-fixture/user/.local/bin/devin acp"),
      ],
    }));
    expect(report.flushes.map((entry) => entry.pid)).toEqual([60]);
    expect(report.runtimes).toEqual([
      { count: 2, name: "codex node_repl", oldestSeconds: 13 * hour, rssKilobytes: 300 * 1024 },
      { count: 1, name: "codex resume", oldestSeconds: 5 * hour, rssKilobytes: 150 * 1024 },
      { count: 1, name: "devin", oldestSeconds: 13 * hour, rssKilobytes: 150 * 1024 },
      { count: 1, name: "devin acp", oldestSeconds: 13 * hour, rssKilobytes: 150 * 1024 },
    ]);
    const text = formatReport(report, { binary: "/abs/agent-browser", summary: "pass=6" });
    expect(text).toContain("report only; nothing was signalled or removed");
    expect(text).toContain("agent-browser doctor (/abs/agent-browser): pass=6");
  });

  test("the CLI has no apply mode and rejects unknown flags", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, `${import.meta.dir}/dev-server-reap.ts`, "--apply"],
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("there is no --apply");
  });

  test("the module source contains no signalling or deletion calls", async () => {
    const source = await Bun.file(`${import.meta.dir}/dev-server-reap.ts`).text();
    expect(source).not.toMatch(/process\.kill|\.kill\(|unlinkSync|rmSync|rmdirSync|"kill"|SIGTERM|SIGKILL/u);
  });
});
