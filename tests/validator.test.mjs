import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverAndValidateSkills, parseFrontmatter, validateRouting } from "../scripts/validate.mjs";

describe("skill validation", () => {
  test("reads bounded Agent Skills frontmatter", async () => {
    const path = resolve(import.meta.dir, "fixtures/canary-source/plugins/canary/skills/canary/SKILL.md");
    const parsed = parseFrontmatter(await readFile(path, "utf8"), path);
    expect(parsed.name).toBe("canary");
    expect(parsed.description).toContain("Do not use");
  });

  test("discovers a portable canary skill", async () => {
    const errors = [];
    const skills = await discoverAndValidateSkills(resolve(import.meta.dir, "fixtures/canary-source"), errors);
    expect(errors).toEqual([]);
    expect(skills.map((item) => item.name)).toEqual(["canary"]);
  });

  test("requires pairwise ownership", () => {
    const catalog = { schemaVersion: 1, skills: [
      { name: "one", plugin: "one", owner: "first bounded owner", positive: ["first request"], negative: ["second request"], adjacent: ["two"] },
      { name: "two", plugin: "two", owner: "second bounded owner", positive: ["second request"], negative: ["first request"], adjacent: ["one"] }
    ] };
    const fixtures = { schemaVersion: 1, cases: [
      { id: "positive-one", kind: "positive", prompt: "choose the first owner", expected: ["one"], excluded: [] },
      { id: "positive-two", kind: "positive", prompt: "choose the second owner", expected: ["two"], excluded: [] },
      { id: "negative-one", kind: "negative", prompt: "exclude the first owner", expected: ["two"], excluded: ["one"] },
      { id: "negative-two", kind: "negative", prompt: "exclude the second owner", expected: ["one"], excluded: ["two"] }
    ] };
    const errors = [];
    validateRouting(catalog, fixtures, errors);
    expect(errors.some((error) => error.includes("exactly one pairwise"))).toBe(true);
  });
});
