#!/usr/bin/env bun
import { resolve } from "node:path";
import { assertBoundedTarget, compareTrees, discoverSkills, hashTree, parseArgs, printJson } from "./lib.mjs";

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = resolve(args.root ?? args.source ?? new URL("..", import.meta.url).pathname);
  const skills = await discoverSkills(root);
  if (skills.size === 0) throw new Error(`no skills discovered under ${root}`);
  const target = args.target ? assertBoundedTarget(args.target, root) : null;
  const results = [];
  for (const [name, source] of skills) {
    const comparison = target ? await compareTrees(source, resolve(target, name)) : { state: "source", source: await hashTree(source) };
    results.push({ name, source, destination: target ? resolve(target, name) : undefined, ...comparison });
  }
  const report = { operation: "audit", changed: false, root, target, skills: results };
  if (args.json) printJson(report);
  else {
    process.stdout.write(`audit: ${skills.size} skill(s); no files changed\n`);
    for (const item of results) process.stdout.write(`${item.name}: ${item.state} ${item.source.sha256}\n`);
  }
  return report;
}

if (import.meta.main) main().catch((error) => { console.error(`audit failed: ${error.message}`); process.exitCode = 1; });
