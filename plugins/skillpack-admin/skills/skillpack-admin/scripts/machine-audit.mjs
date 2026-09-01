#!/usr/bin/env bun
import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { compareTrees, discoverSkills, parseArgs, printJson } from "./lib.mjs";

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const sourceRoot = resolve(args.source ?? args.root ?? new URL("../../../../..", import.meta.url).pathname);
  if (!args["repos-root"]) throw new Error("--repos-root is required; repository locations are never inferred");
  const reposRoot = resolve(args["repos-root"]);
  const reposStat = await exists(reposRoot);
  if (!reposStat?.isDirectory() || reposStat.isSymbolicLink()) throw new Error(`repository root must be a regular directory: ${reposRoot}`);

  const sourceSkills = await discoverSkills(sourceRoot);
  const collisions = [];
  const repositories = [];
  for (const entry of await readdir(reposRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const repository = join(reposRoot, entry.name);
    if (!(await exists(join(repository, ".git")))) continue;
    repositories.push(repository);
    for (const relativeRoot of [".agents/skills", "skills", ".codex/skills"]) {
      const skillsRoot = join(repository, relativeRoot);
      const skillsStat = await exists(skillsRoot);
      if (!skillsStat?.isDirectory() || skillsStat.isSymbolicLink()) continue;
      for (const [name, source] of sourceSkills) {
        const destination = join(skillsRoot, name);
        if (!(await exists(destination))) continue;
        try {
          const comparison = await compareTrees(source, destination);
          collisions.push({
            repository: basename(repository),
            skillRoot: relativeRoot,
            name,
            state: comparison.state,
            changed: comparison.changed ?? [],
            missing: comparison.missing ?? [],
            extra: comparison.extra ?? []
          });
        } catch (error) {
          collisions.push({ repository: basename(repository), skillRoot: relativeRoot, name, state: "unsafe", error: error.message });
        }
      }
    }
  }

  collisions.sort((a, b) => `${a.repository}/${a.skillRoot}/${a.name}`.localeCompare(`${b.repository}/${b.skillRoot}/${b.name}`));
  const counts = {};
  for (const item of collisions) counts[item.state] = (counts[item.state] ?? 0) + 1;
  const report = {
    operation: "machine-audit",
    changed: false,
    source: sourceRoot,
    reposRoot,
    repositoryCount: repositories.length,
    sourceSkillCount: sourceSkills.size,
    collisionCount: collisions.length,
    counts,
    collisions
  };
  if (args.json) printJson(report);
  else {
    process.stdout.write(`machine audit: ${repositories.length} repositories; ${collisions.length} shared-name collision(s); no files changed\n`);
    for (const item of collisions) process.stdout.write(`${item.repository}/${item.skillRoot}/${item.name}: ${item.state}\n`);
  }
  return report;
}

if (import.meta.main) main().catch((error) => { console.error(`machine audit failed: ${error.message}`); process.exitCode = 1; });
