import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeFamily, parseProcessTable } from "./hra-chrome-restart";

const binary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("process table parsing", () => {
  const table = parseProcessTable([
    `  82278 Ss   ${binary}`,
    `  82280 S    ${binary} --type=renderer --foo=bar`,
    `  82281 Z    ${binary} --type=utility`,
    `  82282 S    /Applications/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper`,
    `  90000 S    /usr/bin/other --type=not-chrome`,
    "",
  ].join("\n"));

  test("parses pid, stat, and command columns", () => {
    expect(table).toContainEqual({ pid: 82278, stat: "Ss", command: binary });
  });

  test("selects the Chrome family without zombies, helpers, or lookalikes", () => {
    expect(chromeFamily(table, binary)).toEqual({ mains: [82278], family: [82278, 82280] });
  });

  test("treats a flagless family member as the main process", () => {
    expect(chromeFamily(parseProcessTable(`  1 S    ${binary} --restore-last-session\n`), binary))
      .toEqual({ mains: [1], family: [1] });
  });

  test("ignores unrelated rows and zombie family members", () => {
    expect(chromeFamily(table, "/usr/bin/other")).toEqual({ mains: [], family: [90000] });
  });
});

const darwinIntegration = process.platform === "darwin" ? test : test.skip;

// A symlink to the Bun binary makes argv[0] the fixture path while the process
// really runs Bun — copied platform binaries are killed on exec, but a symlink
// preserves the ps-visible command path the matcher selects on.
darwinIntegration("restarts a stale signed-in Chrome process", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hra-chrome-restart-")));
  const appDir = join(root, "Google Chrome.app");
  const binDir = join(appDir, "Contents/MacOS");
  mkdirSync(binDir, { recursive: true });
  const fixtureBinary = join(binDir, "Google Chrome");
  symlinkSync(process.execPath, fixtureBinary);
  const opener = join(root, "relaunch.sh");
  writeFileSync(opener, `#!/bin/sh\n"$HRA_CHROME_RESTART_FIXTURE" -e 'await Bun.sleep(120e3)' >/dev/null 2>&1 &\nexit 0\n`);
  chmodSync(opener, 0o755);

  const fixture = Bun.spawn([fixtureBinary, "-e", "await Bun.sleep(120e3)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let relaunchedPid: number | undefined;
  try {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { stdout } = Bun.spawnSync(["ps", "-axo", "pid=,stat=,command="]);
      if (chromeFamily(parseProcessTable(stdout.toString()), fixtureBinary).mains.includes(fixture.pid)) break;
      if (Date.now() >= deadline) throw new Error("fixture Chrome never appeared in the process table");
      await Bun.sleep(50);
    }
    const child = Bun.spawn([process.execPath, new URL("./hra-chrome-restart.ts", import.meta.url).pathname], {
      env: {
        ...process.env,
        HRA_CHROME_RESTART_APP_DIR: appDir,
        HRA_CHROME_RESTART_OPEN: opener,
        HRA_CHROME_RESTART_FIXTURE: fixtureBinary,
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`terminating ${fixture.pid}`);
    const match = /relaunched pid (\d+)/.exec(stdout);
    expect(match).not.toBeNull();
    relaunchedPid = Number(match?.[1]);
    expect(relaunchedPid).not.toBe(fixture.pid);
    process.kill(relaunchedPid, 0);
  } finally {
    fixture.kill();
    await fixture.exited;
    if (relaunchedPid !== undefined) { try { process.kill(relaunchedPid); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
