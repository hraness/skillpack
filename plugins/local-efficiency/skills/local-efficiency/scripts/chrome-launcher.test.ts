import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { chromeArguments, resolveChromeExecutable, validateChromeExecutable } from "./chrome-launcher";
import { chromeEnvironment } from "./host-run";

const launcher = join(import.meta.dir, "hra-chrome");
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "le-chrome-"));
  roots.push(root);
  const cwd = join(root, "project");
  const userHome = join(root, "user");
  mkdirSync(cwd);
  mkdirSync(join(userHome, ".agent-browser"), { recursive: true });
  const browser = join(root, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  mkdirSync(dirname(browser), { recursive: true });
  writeFileSync(browser, `#!${process.execPath}\nawait Bun.write(process.env.FAKE_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }));\nprocess.exit(Number(process.env.FAKE_EXIT ?? 0));\n`);
  chmodSync(browser, 0o755);
  const config = join(userHome, ".agent-browser", "config.json");
  const capture = join(root, "capture.json");
  const environment = { ...process.env };
  for (const key of ["HRA_CHROME", "HRA_CHROME_REAL", "AGENT_BROWSER_EXECUTABLE_PATH", "AGENT_BROWSER_CONFIG"]) delete environment[key];
  return { root, cwd, userHome, browser, config, capture, environment };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provisioned Chromium launcher", () => {
  test("retains the pinned agent-browser config while host-run supplies its wrapper", () => {
    const f = fixture();
    writeFileSync(f.config, JSON.stringify({ executablePath: f.browser, args: "--mute-audio" }));
    const configBefore = readFileSync(f.config, "utf8");
    const environment = chromeEnvironment({}, "darwin", launcher, f.cwd);
    expect(resolveChromeExecutable({ ...f, environment, launcher })).toBe(realpathSync(f.browser));
    expect(readFileSync(f.config, "utf8")).toBe(configBefore);
  });

  test("honors explicit executable and config selection ahead of user defaults", () => {
    const f = fixture();
    writeFileSync(f.config, JSON.stringify({ executablePath: "/missing/default" }));
    expect(resolveChromeExecutable({ ...f, environment: { HRA_CHROME_REAL: f.browser }, launcher }))
      .toBe(realpathSync(f.browser));
    const caller = { AGENT_BROWSER_EXECUTABLE_PATH: f.browser };
    const additions = chromeEnvironment(caller, "darwin", launcher, f.cwd);
    expect(caller.AGENT_BROWSER_EXECUTABLE_PATH).toBe(f.browser);
    expect(resolveChromeExecutable({ ...f, environment: { ...caller, ...additions }, launcher }))
      .toBe(realpathSync(f.browser));
    const explicit = join(f.cwd, "browser.json");
    writeFileSync(explicit, JSON.stringify({ executablePath: f.browser }));
    expect(resolveChromeExecutable({ ...f, environment: { AGENT_BROWSER_CONFIG: explicit }, launcher }))
      .toBe(realpathSync(f.browser));
  });

  test("uses project config precedence and preserves a global path when project only sets args", () => {
    const f = fixture();
    const projectConfig = join(f.cwd, "agent-browser.json");
    writeFileSync(f.config, JSON.stringify({ executablePath: "/missing/default" }));
    writeFileSync(projectConfig, JSON.stringify({ executablePath: f.browser }));
    expect(resolveChromeExecutable({ ...f, environment: {}, launcher })).toBe(realpathSync(f.browser));
    writeFileSync(f.config, JSON.stringify({ executablePath: f.browser }));
    writeFileSync(projectConfig, JSON.stringify({ args: "--headless" }));
    expect(resolveChromeExecutable({ ...f, environment: {}, launcher })).toBe(realpathSync(f.browser));
  });

  test("supports configured project Playwright Chromium and relative executable paths", () => {
    const f = fixture();
    const provisioned = join(f.cwd, "node_modules", ".cache", "ms-playwright", "chromium-123", "chrome");
    mkdirSync(dirname(provisioned), { recursive: true });
    symlinkSync(f.browser, provisioned);
    const environment = { HRA_CHROME_REAL: "node_modules/.cache/ms-playwright/chromium-123/chrome" };
    expect(resolveChromeExecutable({ ...f, environment, launcher })).toBe(realpathSync(f.browser));
  });

  test("fails closed for missing, malformed and unusable configuration", () => {
    const f = fixture();
    expect(() => resolveChromeExecutable({ ...f, environment: {}, launcher }))
      .toThrow("no provisioned browser executable selected");
    writeFileSync(f.config, "{");
    expect(() => resolveChromeExecutable({ ...f, environment: {}, launcher })).toThrow("invalid JSON");
    writeFileSync(f.config, JSON.stringify({ executablePath: 42 }));
    expect(() => resolveChromeExecutable({ ...f, environment: {}, launcher })).toThrow("invalid executablePath");
    writeFileSync(f.config, JSON.stringify({ executablePath: f.browser }));
    expect(() => resolveChromeExecutable({ ...f, environment: { HRA_CHROME_REAL: "/missing/browser" }, launcher }))
      .toThrow("browser executable is unavailable");
    expect(() => resolveChromeExecutable({ ...f, environment: { AGENT_BROWSER_CONFIG: "/missing/config" }, launcher }))
      .toThrow("cannot read browser config");
    chmodSync(f.browser, 0o644);
    expect(() => resolveChromeExecutable({ ...f, environment: {}, launcher })).toThrow("browser executable is unavailable");
    expect(() => validateChromeExecutable(f.cwd, f.cwd, launcher)).toThrow("browser executable is unavailable");
  });

  test("rejects system Chrome spellings and symlink aliases before they can execute", () => {
    const f = fixture();
    const forbidden = join(f.root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
    mkdirSync(dirname(forbidden), { recursive: true });
    writeFileSync(forbidden, "#!/bin/sh\nexit 99\n");
    chmodSync(forbidden, 0o755);
    const alias = join(f.root, "innocent-browser");
    symlinkSync(forbidden, alias);
    for (const path of [forbidden, alias, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"]) {
      expect(() => validateChromeExecutable(path, f.cwd, launcher)).toThrow("refusing system Google Chrome");
    }
    expect(() => chromeEnvironment({ AGENT_BROWSER_EXECUTABLE_PATH: alias }, "darwin", launcher, f.cwd))
      .toThrow("refusing system Google Chrome");
    const result = Bun.spawnSync({
      cmd: [launcher], cwd: f.cwd,
      env: { ...f.environment, HRA_CHROME_REAL: alias, FAKE_CAPTURE: f.capture }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(127);
    expect(result.stderr.toString()).toContain("refusing system Google Chrome");
    expect(existsSync(f.capture)).toBe(false);
  });

  test("ignores the wrapper's own alias for config resolution and rejects explicit recursion", () => {
    const f = fixture();
    writeFileSync(f.config, JSON.stringify({ executablePath: f.browser }));
    const alias = join(f.root, "launcher-alias");
    symlinkSync(launcher, alias);
    expect(resolveChromeExecutable({ ...f, environment: { AGENT_BROWSER_EXECUTABLE_PATH: alias }, launcher }))
      .toBe(realpathSync(f.browser));
    expect(() => resolveChromeExecutable({ ...f, environment: { HRA_CHROME_REAL: alias }, launcher }))
      .toThrow("hra-chrome itself");
  });

  test("merges all feature switches, deduplicates mute and preserves other arguments exactly", () => {
    expect(chromeArguments([
      "--headless", "--disable-features=Foo,PaintHolding", "--disable-features", "Bar,Foo,,MacAppCodeSignClone",
      "--mute-audio=false", "--mute-audio", "--user-data-dir=/tmp/profile with spaces", "https://example.test/a?x=$()&y=`literal`",
    ])).toEqual([
      "--disable-features=Foo,PaintHolding,Bar,MacAppCodeSignClone", "--mute-audio", "--headless",
      "--user-data-dir=/tmp/profile with spaces", "https://example.test/a?x=$()&y=`literal`",
    ]);
    expect(chromeArguments([])).toEqual(["--disable-features=PaintHolding,MacAppCodeSignClone", "--mute-audio"]);
    expect(chromeArguments(["--", "--disable-features=literal"]))
      .toEqual(["--disable-features=PaintHolding,MacAppCodeSignClone", "--mute-audio", "--", "--disable-features=literal"]);
    expect(() => chromeArguments(["--disable-features"])).toThrow("requires a comma-separated value");
  });

  test("executes only the configured fixture with one feature switch, muted audio and preserved exit status", () => {
    const f = fixture();
    writeFileSync(f.config, JSON.stringify({ executablePath: f.browser }));
    const result = Bun.spawnSync({
      cmd: [launcher, "--disable-features=Caller", "--disable-features=Caller,Other", "--headless", "url with spaces"],
      cwd: f.cwd,
      env: { ...f.environment, AGENT_BROWSER_CONFIG: f.config, AGENT_BROWSER_EXECUTABLE_PATH: launcher, FAKE_CAPTURE: f.capture, FAKE_EXIT: "23", HRA_CHROME_AUDIO: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(23);
    const captured = JSON.parse(readFileSync(f.capture, "utf8"));
    expect(captured.argv).toEqual(["--disable-features=Caller,Other,PaintHolding,MacAppCodeSignClone", "--mute-audio", "--headless", "url with spaces"]);
  });

  test("preserves the launcher's PID through shell exec, including a symlink entrypoint", async () => {
    const f = fixture();
    const alias = join(f.root, "hra-chrome");
    symlinkSync(launcher, alias);
    const child = Bun.spawn({
      cmd: [alias], cwd: f.cwd,
      env: { ...f.environment, HRA_CHROME_REAL: f.browser, FAKE_CAPTURE: f.capture }, stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(JSON.parse(readFileSync(f.capture, "utf8")).pid).toBe(child.pid);
  });
});


test("preserves extra Playwright communication pipes and the launcher PID", () => {
  const f = fixture();
  writeFileSync(f.browser, '#!/bin/sh\nprintf "%s\\n" "$$" >&4\nIFS= read -r value <&3 || exit 2\nprintf "%s\\n" "$value" >&4\n');
  const probe = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.argv[1], [], { env: process.env, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    let data = "", stderr = "";
    child.stderr.on("data", x => stderr += x);
    child.stdio[3].on("error", () => {});
    child.stdio[4].on("error", () => {});
    child.stdio[4].on("data", x => data += x);
    child.stdio[3].end("playwright-pipe-probe\\n");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      console.log(JSON.stringify({ code, signal, pid: child.pid, data, stderr }));
    });
  `;
  const result = Bun.spawnSync({ cmd: ["node", "-e", probe, launcher], cwd: f.cwd,
    env: { ...f.environment, HRA_CHROME_REAL: f.browser }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const report = JSON.parse(result.stdout.toString());
  expect(report.code, JSON.stringify(report)).toBe(0);
  expect(report.data.trim().split("\n")).toEqual([String(report.pid), "playwright-pipe-probe"]);
});


test("preserves shell metacharacters as literal browser arguments", () => {
  const f = fixture();
  const values = ["", "line\nend\n", "apostrophe'quote", "$(printf INJECTED)", "`printf INJECTED`", "semi;colon", "\\backslash", "* ? [pattern]", "双引号\"text"];
  const result = Bun.spawnSync({ cmd: [launcher, ...values], cwd: f.cwd,
    env: { ...f.environment, HRA_CHROME_REAL: f.browser, FAKE_CAPTURE: f.capture }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const captured = JSON.parse(readFileSync(f.capture, "utf8"));
  expect(captured.argv).toEqual(["--disable-features=PaintHolding,MacAppCodeSignClone", "--mute-audio", ...values]);
});
