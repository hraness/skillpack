import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseHostRunCli } from "./host-run";
import {
  defaultHelperAppPath,
  helperBundleId,
  helperConfigPath,
  helperExecutablePath,
  helperSourceDigest,
  helperSourceDirectory,
  inspectHelper,
  installHelper,
  parseHelperConfig,
} from "./mac-ui-helper";

const onMac = test.skipIf(process.platform !== "darwin");
const uid = process.getuid?.() ?? 0;
// The launchd tests need a GUI launchd domain (a logged-in console user).
const guiDomain = process.platform === "darwin"
  && spawnSync("launchctl", ["print", `gui/${uid}`], { stdio: "ignore" }).status === 0;
const launchdMac = test.skipIf(!guiDomain);

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "le-helper-")));
}

describe("HostRun UI helper configuration", () => {
  test("config path follows the override, XDG_CONFIG_HOME, then HOME", () => {
    expect(helperConfigPath({ LOCAL_EFFICIENCY_MAC_UI_CONFIG: "/opt/x.json" })).toBe("/opt/x.json");
    expect(helperConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/opt/home-a")).toBe("/xdg/host-run/mac-ui.json");
    expect(helperConfigPath({}, "/opt/home-a")).toBe("/opt/home-a/.config/host-run/mac-ui.json");
    expect(defaultHelperAppPath("/opt/home-a")).toBe("/opt/home-a/Applications/HostRun UI.app");
  });

  test("config must name an absolute .app path", () => {
    expect(parseHelperConfig(JSON.stringify({ helper: { app: "/opt/A/HostRun UI.app" } }))).toEqual({ app: "/opt/A/HostRun UI.app" });
    expect(() => parseHelperConfig("{")).toThrow("not valid JSON");
    expect(() => parseHelperConfig(JSON.stringify({ helper: { app: "relative.app" } }))).toThrow("helper.app");
    expect(() => parseHelperConfig(JSON.stringify({ helper: { app: "/opt/bash" } }))).toThrow("helper.app");
  });

  test("the source digest covers the launcher and its Info.plist", () => {
    const root = scratch();
    try {
      cpSync(helperSourceDirectory, root, { recursive: true });
      const original = helperSourceDigest(root);
      expect(original).toBe(helperSourceDigest(helperSourceDirectory));
      writeFileSync(join(root, "Info.plist"), `${readFileSync(join(root, "Info.plist"), "utf8")}\n`);
      expect(helperSourceDigest(root)).not.toBe(original);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("the Info.plist declares the bundle id the driver checks", () => {
    const plist = readFileSync(join(helperSourceDirectory, "Info.plist"), "utf8");
    expect(plist).toContain(`<string>${helperBundleId}</string>`);
    expect(plist).toContain("<key>LSUIElement</key><true/>");
    const driver = readFileSync(join(import.meta.dir, "mac-ui-remote.sh"), "utf8");
    expect(driver).toContain(`Identifier=${helperBundleId}`);
  });

  test("the CLI parses the mac-ui subcommands without touching run parsing", () => {
    expect(parseHostRunCli(["mac-ui", "probe"])).toEqual({ appPath: null, kind: "mac-ui", subcommand: "probe" });
    expect(parseHostRunCli(["mac-ui", "install-helper", "--app=/opt/A/HostRun UI.app"]))
      .toEqual({ appPath: "/opt/A/HostRun UI.app", kind: "mac-ui", subcommand: "install-helper" });
    expect(() => parseHostRunCli(["mac-ui", "install-helper", "--app=bash"])).toThrow("absolute path");
    expect(() => parseHostRunCli(["mac-ui", "probe", "--now"])).toThrow("unknown host-run mac-ui probe argument");
    expect(() => parseHostRunCli(["mac-ui", "run", "bash"])).toThrow("usage: host-run mac-ui");
    expect(parseHostRunCli(["--lane=mac-ui", "--", "true"]).kind).toBe("run");
  });
});

describe("HostRun UI build and launcher", () => {
  onMac("installs once, then leaves an up-to-date app and its code hash alone", () => {
    const root = scratch();
    try {
      const app = join(root, "Applications", "HostRun UI.app");
      const configPath = join(root, "config", "mac-ui.json");
      const lines: string[] = [];
      const first = installHelper({ appPath: app, configPath, log: (line) => lines.push(line) });
      expect(first.changed).toBe(true);
      expect(first.configWritten).toBe(true);
      expect(first.status.identifier).toBe(helperBundleId);
      expect(first.status.cdhash).toMatch(/^[0-9a-f]{40}$/u);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ helper: { app } });
      const second = installHelper({ appPath: app, configPath, log: (line) => lines.push(line) });
      expect(second.changed).toBe(false);
      expect(second.configWritten).toBe(false);
      expect(second.status.cdhash).toBe(first.status.cdhash);
      expect(lines.at(-1)).toContain("is up to date");
      // A tampered binary no longer verifies and is rebuilt.
      writeFileSync(helperExecutablePath(app), Buffer.concat([readFileSync(helperExecutablePath(app)), Buffer.from([0])]));
      expect(inspectHelper(app).problem).toContain("signature does not verify");
      const repaired = installHelper({ appPath: app, configPath, log: () => {} });
      expect(repaired.changed).toBe(true);
      expect(repaired.status.problem).toBeNull();
      expect(existsSync(`${app}.new-${process.pid}`)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 120_000);

  onMac("refuses arbitrary argv and any caller other than launchd", () => {
    const root = scratch();
    try {
      const app = join(root, "HostRun UI.app");
      installHelper({ appPath: app, configPath: join(root, "mac-ui.json"), log: () => {} });
      const marker = join(root, "ran");
      for (const argv of [["/bin/bash", "-c", `touch ${marker}`], ["run", root, "0123456789abcdef0123"], []]) {
        const result = spawnSync(helperExecutablePath(app), argv, { encoding: "utf8" });
        expect(result.status).toBe(69);
        expect(result.stderr).toContain("[HostRun UI] refused");
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 120_000);

  launchdMac("under launchd it runs only a staged run directory with a matching one-time token", async () => {
    const root = scratch();
    const labels: string[] = [];
    try {
      const app = join(root, "HostRun UI.app");
      installHelper({ appPath: app, configPath: join(root, "mac-ui.json"), log: () => {} });
      const home = join(root, "home");
      const stateRoot = join(home, ".local", "state", "host-run", "remote");
      mkdirSync(stateRoot, { mode: 0o700, recursive: true });

      const launch = async (options: { id: string; label?: string; token: string; staged: string; dir?: string }) => {
        const dir = join(stateRoot, options.id);
        mkdirSync(dir, { mode: 0o700 });
        chmodSync(dir, 0o700);
        writeFileSync(join(dir, "helper-token"), `${options.staged}\n`, { mode: 0o600 });
        writeFileSync(join(dir, "job.sh"), `#!/bin/bash\necho ran >${JSON.stringify(join(dir, "ran"))}\nexit 7\n`, { mode: 0o700 });
        const label = options.label ?? `dev.hraness.host-run.mac-ui.${options.id}`;
        labels.push(label);
        const plist = join(root, `${options.id}.plist`);
        const errPath = join(root, `${options.id}.err`);
        writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${helperExecutablePath(app)}</string><string>run</string><string>${options.dir ?? dir}</string><string>${options.token}</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${home}</string></dict>
<key>StandardErrorPath</key><string>${errPath}</string>
<key>RunAtLoad</key><true/>
</dict></plist>`);
        expect(spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist]).status).toBe(0);
        let exitCode: number | null = null;
        const deadline = Date.now() + 30_000;
        while (exitCode === null && Date.now() < deadline) {
          await Bun.sleep(200);
          const printed = spawnSync("launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" }).stdout;
          const match = /last exit code = (\d+)/u.exec(printed);
          if (match && !/state = running/u.test(printed)) exitCode = Number(match[1]);
        }
        spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`]);
        const stderr = existsSync(errPath) ? readFileSync(errPath, "utf8") : "";
        return { exitCode, ran: existsSync(join(dir, "ran")), stderr, tokenLeft: existsSync(join(dir, "helper-token")) };
      };

      const token = "a".repeat(48);
      const tag = `t${process.pid}x${Date.now()}`;
      const good = await launch({ id: `${tag}-good`, staged: token, token });
      expect(good).toEqual({ exitCode: 7, ran: true, stderr: "", tokenLeft: false });
      const wrongToken = await launch({ id: `${tag}-token`, staged: token, token: "b".repeat(48) });
      expect(wrongToken.exitCode).toBe(69);
      expect(wrongToken.ran).toBe(false);
      expect(wrongToken.stderr).toContain("token does not match");
      const wrongLabel = await launch({ id: `${tag}-label`, label: `dev.hraness.host-run.mac-ui.${tag}-other`, staged: token, token });
      expect(wrongLabel.exitCode).toBe(69);
      expect(wrongLabel.stderr).toContain("label does not match");
      const outside = join(root, "elsewhere", `${tag}-out`);
      mkdirSync(outside, { mode: 0o700, recursive: true });
      const elsewhere = await launch({ dir: outside, id: `${tag}-out`, staged: token, token });
      expect(elsewhere.exitCode).toBe(69);
      expect(elsewhere.stderr).toContain("not directly under");
    } finally {
      for (const label of labels) spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`]);
      rmSync(root, { force: true, recursive: true });
    }
  }, 180_000);
});
