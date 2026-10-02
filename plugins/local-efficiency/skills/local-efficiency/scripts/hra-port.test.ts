import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocatePort,
  fnv1a32,
  leaseIsLive,
  portIsFree,
  portRangeSize,
  portRangeStart,
  preferredPort,
  probeSequence,
  readLease,
  readLeases,
  requireServiceName,
  resolvePortStateRoot,
} from "./hra-port";

describe("hra-port", () => {
  test("hashes deterministically into the port range", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    const port = preferredPort("/tmp/le-fixture/soundfish-ui-20260929", "web");
    expect(port).toBe(preferredPort("/tmp/le-fixture/soundfish-ui-20260929", "web"));
    expect(port).toBeGreaterThanOrEqual(portRangeStart);
    expect(port).toBeLessThan(portRangeStart + portRangeSize);
    expect(preferredPort("/w/a", "web")).not.toBe(preferredPort("/w/b", "web"));
    const sequence = probeSequence("/w/a", "web", 3);
    expect(sequence[1]).toBe(sequence[0] === portRangeStart + portRangeSize - 1 ? portRangeStart : (sequence[0] ?? 0) + 1);
  });

  test("validates names and state roots", () => {
    expect(requireServiceName("web")).toBe("web");
    expect(() => requireServiceName("bad name")).toThrow("service name");
    expect(() => requireServiceName("")).toThrow("service name");
    expect(resolvePortStateRoot({}, "/tmp/le-home")).toBe("/tmp/le-home/.local/state/local-efficiency/ports-v1");
    expect(resolvePortStateRoot({ XDG_STATE_HOME: "/s" }, "/tmp/le-home")).toBe("/s/local-efficiency/ports-v1");
    expect(() => resolvePortStateRoot({ LOCAL_EFFICIENCY_PORTS_ROOT: "rel" })).toThrow("absolute");
  });

  test("returns the same leased port for the same worktree and name", async () => {
    const root = mkdtempSync(join(tmpdir(), "le-hra-port-"));
    try {
      const options = { isFree: () => true, requesterPid: 1234, root, worktreeExists: () => true };
      const first = await allocatePort("/w/a", "web", options);
      expect(first).toBe(preferredPort("/w/a", "web"));
      const second = await allocatePort("/w/a", "web", { ...options, isFree: () => false });
      expect(second).toBe(first);
      const lease = readLease(root, first);
      expect(lease).toMatchObject({ name: "web", port: first, requesterPid: 1234, worktree: "/w/a" });
      expect(readdirSync(root)).toEqual([`${first}.json`]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("steps past ports leased by live worktrees or busy on the host", async () => {
    const root = mkdtempSync(join(tmpdir(), "le-hra-port-collide-"));
    try {
      const [first, second, third] = probeSequence("/w/new", "web", 3);
      writeFileSync(join(root, `${first}.json`), JSON.stringify({
        createdAt: new Date().toISOString(),
        name: "api",
        port: first,
        renewedAt: new Date().toISOString(),
        requesterPid: 1,
        version: 1,
        worktree: "/w/other",
      }));
      const port = await allocatePort("/w/new", "web", {
        isFree: (candidate) => candidate !== second,
        root,
        worktreeExists: () => true,
      });
      expect(port).toBe(third);
      expect(readLeases(root).map((lease) => lease.port).sort()).toEqual([first, third].sort());
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reuses a port whose lease belongs to a missing or week-old worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "le-hra-port-stale-"));
    try {
      const [first] = probeSequence("/w/new", "web", 1);
      const stale = {
        createdAt: "2026-09-01T00:00:00.000Z",
        name: "web",
        port: first,
        renewedAt: "2026-09-01T00:00:00.000Z",
        requesterPid: 1,
        version: 1 as const,
        worktree: "/w/gone",
      };
      writeFileSync(join(root, `${first}.json`), JSON.stringify(stale));
      const now = new Date("2026-09-29T00:00:00.000Z");
      expect(leaseIsLive(stale, now, () => true)).toBe(false);
      expect(leaseIsLive({ ...stale, renewedAt: "2026-09-28T00:00:00.000Z" }, now, () => false)).toBe(false);
      expect(leaseIsLive({ ...stale, renewedAt: "2026-09-28T00:00:00.000Z" }, now, () => true)).toBe(true);
      const port = await allocatePort("/w/new", "web", { isFree: () => true, now, root, worktreeExists: () => true });
      expect(port).toBe(first);
      expect(readLease(root, first ?? 0)?.worktree).toBe("/w/new");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("detects a port that something is listening on", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      expect(await portIsFree(address.port)).toBe(false);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  test("prints a port from the CLI and records the lease", () => {
    const root = mkdtempSync(join(tmpdir(), "le-hra-port-cli-"));
    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, join(import.meta.dir, "hra-port.ts"), "web", `--worktree=${root}`],
        env: { ...process.env, LOCAL_EFFICIENCY_PORTS_ROOT: join(root, "ports") },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const port = Number(result.stdout.toString().trim());
      expect(port).toBeGreaterThanOrEqual(portRangeStart);
      expect(readLeases(join(root, "ports")).map((lease) => lease.port)).toEqual([port]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
