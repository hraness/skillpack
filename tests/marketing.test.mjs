import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const packs = [
  { name: "hraness-engineering", promise: /bounded|evidence/i },
  { name: "code-orchestrator", promise: /approved|review/i },
  { name: "semantic-algos", promise: /explicit|inspectable/i },
  { name: "skillpack-admin", promise: /audit|backup/i }
];

async function json(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

function expectSectionsInOrder(markdown, sections) {
  let previous = -1;
  for (const section of sections) {
    const current = markdown.indexOf(section);
    expect(current, `missing section ${section}`).toBeGreaterThan(previous);
    previous = current;
  }
}

async function discoveredSkillCount() {
  let count = 0;
  for (const pack of packs) {
    const entries = await readdir(join(root, "plugins", pack.name, "skills"), { withFileTypes: true });
    count += entries.filter((entry) => entry.isDirectory()).length;
  }
  return count;
}

describe("public product story", () => {
  test("root narrative moves from result through proof and boundaries to action", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const packageMetadata = await json("package.json");
    const skillCount = await discoveredSkillCount();

    expect(readme).toContain(`${skillCount} workflows`);
    expect(readme).toContain(`v${packageMetadata.version}`);
    expect(readme).toContain("Hraness is the publisher, not a product dependency.");
    for (const pack of packs) expect(readme).toContain(`plugins/${pack.name}`);
    expectSectionsInOrder(readme, [
      "## First proof",
      "## How the pack works",
      "## Choose only what fits",
      "## Install in the host you already use",
      "## Evidence you can inspect",
      "## Boundaries",
      "## Questions",
      "## Start with source"
    ]);
  });

  test("every installable pack exposes the same proof-led navigation", async () => {
    for (const pack of packs) {
      const readme = await readFile(join(root, "plugins", pack.name, "README.md"), "utf8");
      expectSectionsInOrder(readme, [
        "## First proof",
        "## How it works",
        "## Interfaces",
        "## Evidence",
        "## Boundaries",
        "## Questions",
        "## Start"
      ]);
      expect(readme).toMatch(pack.promise);
    }
  });

  test("host descriptions preserve each pack's product promise", async () => {
    const packageMetadata = await json("package.json");
    const copilot = await json(".github/plugin/marketplace.json");
    const cursorMarketplace = await json(".cursor-plugin/marketplace.json");

    expect(copilot.metadata.version).toBe(packageMetadata.version);
    expect(cursorMarketplace.metadata.version).toBe(packageMetadata.version);

    for (const pack of packs) {
      const portable = await json(`plugins/${pack.name}/plugin.json`);
      const codex = await json(`plugins/${pack.name}/.codex-plugin/plugin.json`);
      const cursor = await json(`plugins/${pack.name}/.cursor-plugin/plugin.json`);
      const descriptions = [portable.description, codex.description, codex.interface.longDescription, cursor.description];
      const copilotEntry = copilot.plugins.find((entry) => entry.name === pack.name);
      const cursorEntry = cursorMarketplace.plugins.find((entry) => entry.name === pack.name);
      if (copilotEntry) descriptions.push(copilotEntry.description);
      if (cursorEntry) descriptions.push(cursorEntry.description);

      expect(new Set([portable.version, codex.version, cursor.version]).size).toBe(1);
      expect(portable.version).toBe(packageMetadata.version);
      expect(copilotEntry?.version).toBe(packageMetadata.version);
      if (cursorEntry) expect(cursorEntry.version).toBe(packageMetadata.version);
      for (const description of descriptions) expect(description).toMatch(pack.promise);
    }
  });
});
