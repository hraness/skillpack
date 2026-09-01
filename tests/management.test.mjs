import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { main as audit } from "../plugins/hra-skillpack/skills/hra-skillpack/scripts/audit.mjs";
import { main as adopt } from "../plugins/hra-skillpack/skills/hra-skillpack/scripts/adopt.mjs";
import { main as machineAudit } from "../plugins/hra-skillpack/skills/hra-skillpack/scripts/machine-audit.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function target() {
  const root = await mkdtemp(join(tmpdir(), "hra-skillpack-canary-"));
  roots.push(root);
  return join(root, "skills");
}

const source = resolve(import.meta.dir, "fixtures/canary-source");

describe("offline adoption canary", () => {
  test("preview is read-only and apply creates the selected skill", async () => {
    const destination = await target();
    const preview = await adopt(["--source", source, "--target", destination, "--skill", "canary", "--json"]);
    expect(preview.changed).toBe(false);
    expect(preview.plan[0].action).toBe("create");

    const applied = await adopt(["--source", source, "--target", destination, "--skill", "canary", "--apply", "--json"]);
    expect(applied.changed).toBe(true);
    expect(await readFile(join(destination, "canary/SKILL.md"), "utf8")).toContain("name: canary");
    const report = await audit(["--root", source, "--target", destination, "--json"]);
    expect(report.skills[0].state).toBe("match");
  });

  test("drift requires repair and repair keeps extra files with a backup", async () => {
    const destination = await target();
    await adopt(["--source", source, "--target", destination, "--all", "--apply"]);
    await writeFile(join(destination, "canary/SKILL.md"), "changed\n");
    await writeFile(join(destination, "canary/user-note.md"), "preserve me\n");
    await expect(adopt(["--source", source, "--target", destination, "--all"])).rejects.toThrow("refused without --repair");

    const repaired = await adopt(["--source", source, "--target", destination, "--all", "--repair", "--apply", "--json"]);
    expect(repaired.applied[0].backup).toContain(".hra-skillpack-backups");
    expect(await readFile(join(destination, "canary/user-note.md"), "utf8")).toBe("preserve me\n");
    const report = await audit(["--root", source, "--target", destination, "--json"]);
    expect(report.skills[0].state).toBe("drift");
    expect(report.skills[0].extra).toEqual(["user-note.md"]);
  });

  test("machine audit reports repository-local collisions without writing", async () => {
    const repositories = await mkdtemp(join(tmpdir(), "hra-skillpack-repositories-"));
    roots.push(repositories);
    const localSkill = join(repositories, "sample/.agents/skills/canary");
    await mkdir(join(repositories, "sample/.git"), { recursive: true });
    await mkdir(join(localSkill, "agents"), { recursive: true });
    await writeFile(join(localSkill, "SKILL.md"), await readFile(join(source, "plugins/canary/skills/canary/SKILL.md")));
    await writeFile(join(localSkill, "agents/openai.yaml"), await readFile(join(source, "plugins/canary/skills/canary/agents/openai.yaml")));

    const report = await machineAudit(["--source", source, "--repos-root", repositories, "--json"]);
    expect(report.changed).toBe(false);
    expect(report.repositoryCount).toBe(1);
    expect(report.collisions).toEqual([{ repository: "sample", skillRoot: ".agents/skills", name: "canary", state: "match", changed: [], missing: [], extra: [] }]);
  });

  test("repair refuses a symbolic link inside the managed destination", async () => {
    const destination = await target();
    await adopt(["--source", source, "--target", destination, "--all", "--apply"]);
    const outside = await mkdtemp(join(tmpdir(), "hra-skillpack-outside-"));
    roots.push(outside);
    await mkdir(join(destination, "canary/nested"), { recursive: true });
    await symlink(outside, join(destination, "canary/nested/redirect"));
    await expect(audit(["--root", source, "--target", destination])).rejects.toThrow("symbolic link refused");
  });

  test("repair refuses a skill destination that is itself a symbolic link", async () => {
    const destination = await target();
    const outside = await mkdtemp(join(tmpdir(), "hra-skillpack-outside-skill-"));
    roots.push(outside);
    await mkdir(destination, { recursive: true });
    await symlink(outside, join(destination, "canary"));
    await expect(adopt(["--source", source, "--target", destination, "--all", "--repair", "--apply"])).rejects.toThrow("unsafe destination refused");
  });
});
