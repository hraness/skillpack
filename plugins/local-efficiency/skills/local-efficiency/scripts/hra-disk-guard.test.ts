import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bunInstallActive,
  bunStagingName,
  classifyBunStaging,
  classifyClones,
  cloneDirectory,
  headroomWarning,
  heldClones,
  hookOutput,
  janitorReport,
  janitorSummary,
  reportDue,
  resolveDiskStateRoot,
  topDirectories,
} from "./hra-disk-guard";

const gib = 1024 ** 3;
const hour = 3_600_000;

describe("hra-disk-guard", () => {
  test("warns below 60 GiB and emits only a hook systemMessage", () => {
    expect(headroomWarning(61 * gib)).toBeNull();
    expect(headroomWarning(20 * gib)).toContain("20.0 GiB free (< 60 GiB)");
    expect(headroomWarning(70 * gib, 80)).toContain("< 80 GiB");
    expect(hookOutput(null)).toBe("");
    const output = JSON.parse(hookOutput("Low disk"));
    expect(output).toEqual({ systemMessage: "Low disk" });
    expect(output).not.toHaveProperty("decision");
    expect(output).not.toHaveProperty("hookSpecificOutput");
  });

  test("the check command always exits 0", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "hra-disk-guard.ts"), "check", "--hook", "--warn-gib=100000"],
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).systemMessage).toContain("Low disk");
  });

  test("classifies code_sign_clone copies by age and open handles", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    const held = heldClones([
      "p82278", "cGoogle Chrome", "ftxt",
      "n/private/var/folders/x/X/com.google.Chrome.code_sign_clone/code_sign_clone.oBtgkD/Google Chrome.app.bundle/Contents/MacOS/Google Chrome",
    ].join("\n"));
    expect([...held]).toEqual(["code_sign_clone.oBtgkD"]);
    const candidates = classifyClones("/X", [
      { modifiedAt: now - 30 * hour, name: "code_sign_clone.oBtgkD" },
      { modifiedAt: now - 30 * hour, name: "code_sign_clone.old111" },
      { modifiedAt: now - 2 * hour, name: "code_sign_clone.new222" },
    ], held, now);
    expect(candidates.map((c) => [c.name, c.eligible, c.reason])).toEqual([
      ["code_sign_clone.oBtgkD", false, "held open"],
      ["code_sign_clone.old111", true, "older than 12h, not held"],
      ["code_sign_clone.new222", false, "younger than 12h"],
    ]);
    expect(cloneDirectory("/var/folders/vh/abc/T/")).toMatch(/\/vh\/abc\/X\/com\.google\.Chrome\.code_sign_clone$/u);
  });

  test("classifies bun staging dirs and holds them while bun install runs", () => {
    expect(bunStagingName.test(".18d9882ef9c1fd39-0000023D.node-gyp")).toBe(true);
    expect(bunStagingName.test(".18d9882ef9c1fd39-0000023d.node-gyp")).toBe(false);
    expect(bunStagingName.test("bunx-501-next")).toBe(false);
    expect(bunInstallActive("/tmp/le-fixture/.bun/bin/bun install --frozen-lockfile\n")).toBe(true);
    expect(bunInstallActive("bun add zod\n")).toBe(true);
    expect(bunInstallActive("bun run check\nbun test\n")).toBe(false);
    const now = Date.parse("2026-09-29T12:00:00Z");
    const entries = [
      { modifiedAt: now - 2 * hour, name: ".18d9882ef9c1fd39-0000023D.node-gyp" },
      { modifiedAt: now - 10 * 60_000, name: ".18d9882ef9c1fd40-0000023E.react" },
    ];
    expect(classifyBunStaging("/T", entries, false, now).map((c) => c.eligible)).toEqual([true, false]);
    expect(classifyBunStaging("/T", entries, true, now).map((c) => c.reason))
      .toEqual(["bun install running", "bun install running"]);
  });

  test("janitor report counts fixtures without deleting anything", () => {
    const root = mkdtempSync(join(tmpdir(), "le-disk-janitor-"));
    try {
      const clones = join(root, "X", "com.google.Chrome.code_sign_clone");
      const temporary = join(root, "T");
      const now = Date.now();
      for (const name of ["code_sign_clone.aaa111", "code_sign_clone.bbb222", "code_sign_clone.ccc333"]) {
        mkdirSync(join(clones, name, "Google Chrome.app.bundle"), { recursive: true });
      }
      mkdirSync(join(temporary, ".18d9882ef9c1fd39-0000023D.node-gyp"), { recursive: true });
      const old = (now - 13 * hour) / 1_000;
      utimesSync(join(clones, "code_sign_clone.aaa111"), old, old);
      utimesSync(join(clones, "code_sign_clone.bbb222"), old, old);
      utimesSync(join(temporary, ".18d9882ef9c1fd39-0000023D.node-gyp"), old, old);
      const report = janitorReport({
        cloneRoot: clones,
        lsofOutput: `n${clones}/code_sign_clone.bbb222/Google Chrome.app.bundle/x`,
        now,
        psOutput: "bun test\n",
        sizes: true,
        temporaryDirectory: temporary,
      });
      expect(report.clones.candidates.filter((c) => c.eligible).map((c) => c.name)).toEqual(["code_sign_clone.aaa111"]);
      expect(report.clones.candidates.find((c) => c.eligible)?.sizeKilobytes).toBeGreaterThanOrEqual(0);
      expect(report.bunStaging.candidates.filter((c) => c.eligible)).toHaveLength(1);
      expect(janitorSummary(report)).toContain("code_sign_clone total=3 held=1 young=1 eligible=1");
      expect(readdirSync(clones).sort()).toEqual(["code_sign_clone.aaa111", "code_sign_clone.bbb222", "code_sign_clone.ccc333"]);
      expect(readdirSync(temporary)).toHaveLength(1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("the janitor has no deletion mode", async () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "hra-disk-guard.ts"), "janitor"],
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("report-only");
    const source = await Bun.file(join(import.meta.dir, "hra-disk-guard.ts")).text();
    expect(source).not.toMatch(/rmSync|rmdirSync|unlinkSync|\brm\b"|"-rf"|process\.kill/u);
  });

  test("ranks the top directories and gates the daily report", () => {
    const sizes: Record<string, number> = { "/a": 5, "/b": 50, "/c": 20 };
    expect(topDirectories(["/a", "/b", "/c"], (path) => sizes[path] ?? null, 2))
      .toEqual([{ path: "/b", sizeKilobytes: 50 }, { path: "/c", sizeKilobytes: 20 }]);
    expect(resolveDiskStateRoot({}, "/tmp/le-home")).toBe("/tmp/le-home/.local/state/local-efficiency/disk-v1");
    const root = mkdtempSync(join(tmpdir(), "le-disk-state-"));
    try {
      expect(reportDue(root)).toBe(true);
      writeFileSync(join(root, "last-report.json"), JSON.stringify({ at: new Date().toISOString() }));
      expect(reportDue(root)).toBe(false);
      expect(reportDue(root, Date.now() + 25 * hour)).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
