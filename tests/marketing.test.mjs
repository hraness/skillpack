import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const packs = ["hraness-engineering", "code-orchestrator", "semantic-algos", "skillpack-admin"];

const numberWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

async function json(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function skillCount(pack) {
  const entries = await readdir(join(root, "plugins", pack, "skills"), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).length;
}

function countPattern(count) {
  const word = numberWords[count];
  return word ? new RegExp(`\\b(?:${count}|${word})\\b`, "i") : new RegExp(`\\b${count}\\b`);
}

function headingAnchors(markdown) {
  return new Set(
    [...markdown.matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
      match[1].trim().toLowerCase().replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-")
    )
  );
}

function firstSection(markdown) {
  const start = markdown.indexOf("\n## ");
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

describe("public product story", () => {
  test("root README states the current skill count, release, packs, and install commands", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const packageMetadata = await json("package.json");
    let total = 0;
    for (const pack of packs) total += await skillCount(pack);

    expect(readme).toContain(`${total} workflows`);
    expect(readme).toContain(`v${packageMetadata.version}`);
    expect(readme).toContain(`codex plugin marketplace add hraness/skillpack --ref v${packageMetadata.version}`);
    for (const pack of packs) expect(readme).toContain(`plugins/${pack}`);
    expect(firstSection(readme)).toContain("npx skills add hraness/skillpack");
    expect(readme).not.toContain("—");
  });

  test("root README keeps the no-account and licensing limits", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const packageMetadata = await json("package.json");

    expect(packageMetadata.dependencies).toBeUndefined();
    expect(readme).toContain("No account or payment is needed to use any skill.");
    expect(readme).toMatch(/Rob Cheung.{0,120}not represented as MIT-licensed/s);
  });

  test("each pack README opens with a runnable example and states its skill count", async () => {
    const rootReadme = await readFile(join(root, "README.md"), "utf8");
    const anchors = headingAnchors(rootReadme);

    for (const pack of packs) {
      const readme = await readFile(join(root, "plugins", pack, "README.md"), "utf8");
      const lead = readme.slice(0, readme.indexOf("\n## "));
      const opening = firstSection(readme);

      expect(lead).toMatch(countPattern(await skillCount(pack)));
      expect(opening).toMatch(/```sh\n|^> /m);
      expect(readme).not.toContain("—");
      for (const match of readme.matchAll(/\.\.\/\.\.\/README\.md#([a-z0-9-]+)/g)) {
        expect(anchors.has(match[1]), `${pack} links to a missing root README section #${match[1]}`).toBeTrue();
      }
    }
  });

  test("skillpack admin example runs from the repository root", async () => {
    const readme = await readFile(join(root, "plugins", "skillpack-admin", "README.md"), "utf8");
    expect(readme).toContain("bun plugins/skillpack-admin/scripts/audit.mjs --root .");
    expect(readme).not.toContain("bun scripts/audit.mjs --root ../..");
  });

  test("host listings share one version and describe each pack without em dashes", async () => {
    const packageMetadata = await json("package.json");
    const copilot = await json(".github/plugin/marketplace.json");
    const cursorMarketplace = await json(".cursor-plugin/marketplace.json");
    const skillsSh = await json("skills.sh.json");

    expect(copilot.metadata.version).toBe(packageMetadata.version);
    expect(cursorMarketplace.metadata.version).toBe(packageMetadata.version);
    for (const text of [packageMetadata.description, copilot.metadata.description, cursorMarketplace.metadata.description]) {
      expect(text).not.toContain("—");
    }
    for (const grouping of skillsSh.groupings) expect(grouping.description).not.toContain("—");

    for (const pack of packs) {
      const portable = await json(`plugins/${pack}/plugin.json`);
      const codex = await json(`plugins/${pack}/.codex-plugin/plugin.json`);
      const cursor = await json(`plugins/${pack}/.cursor-plugin/plugin.json`);
      const descriptions = [
        portable.description,
        codex.description,
        codex.interface.shortDescription,
        codex.interface.longDescription,
        cursor.description
      ];
      const copilotEntry = copilot.plugins.find((entry) => entry.name === pack);
      const cursorEntry = cursorMarketplace.plugins.find((entry) => entry.name === pack);
      if (copilotEntry) descriptions.push(copilotEntry.description);
      if (cursorEntry) descriptions.push(cursorEntry.description);

      expect(new Set([portable.version, codex.version, cursor.version]).size).toBe(1);
      expect(portable.version).toBe(packageMetadata.version);
      expect(copilotEntry?.version).toBe(packageMetadata.version);
      if (cursorEntry) expect(cursorEntry.version).toBe(packageMetadata.version);
      expect(codex.interface.longDescription).toMatch(countPattern(await skillCount(pack)));
      for (const description of descriptions) {
        expect(description.length).toBeGreaterThan(0);
        expect(description).not.toContain("—");
      }
    }
  });
});
