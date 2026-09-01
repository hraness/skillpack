#!/usr/bin/env bun
import { resolve, join } from "node:path";
import { assertBoundedTarget, assertNoSymlinkAncestors, compareTrees, copyTreeOverlay, discoverSkills, parseArgs, printJson, timestamp } from "./lib.mjs";

export async function main(argv = process.argv.slice(2), defaults = {}) {
  const args = { ...defaults, ...parseArgs(argv) };
  const sourceRoot = resolve(args.source ?? new URL("..", import.meta.url).pathname);
  if (!args.target) throw new Error("--target is required; host directories are never inferred");
  const targetRoot = assertBoundedTarget(args.target, sourceRoot);
  await assertNoSymlinkAncestors(targetRoot);
  const discovered = await discoverSkills(sourceRoot);
  const requested = args.all ? [...discovered.keys()] : args.skills;
  if (!requested?.length) throw new Error("select at least one --skill or use --all");
  const unknown = requested.filter((name) => !discovered.has(name));
  if (unknown.length) throw new Error(`unknown skill(s): ${unknown.join(", ")}`);
  if (new Set(requested).size !== requested.length) throw new Error("duplicate --skill selection");

  const plan = [];
  for (const name of requested.sort()) {
    const source = discovered.get(name);
    const destination = resolve(targetRoot, name);
    const comparison = await compareTrees(source, destination);
    const action = comparison.reason ? "unsafe" : comparison.state === "missing" ? "create" : comparison.state === "match" ? "none" : args.repair ? "repair" : "conflict";
    plan.push({ name, source, destination, action, comparison });
  }
  const unsafe = plan.filter((item) => item.action === "unsafe");
  if (unsafe.length) throw new Error(`unsafe destination refused: ${unsafe.map((item) => `${item.name} (${item.comparison.reason})`).join(", ")}`);
  const conflicts = plan.filter((item) => item.action === "conflict");
  if (conflicts.length) throw new Error(`differing destination refused without --repair: ${conflicts.map((item) => item.name).join(", ")}`);

  const applied = [];
  if (args.apply) {
    for (const item of plan) {
      if (item.action === "none") continue;
      let backup = null;
      if (item.action === "repair") {
        const suffix = item.comparison.destination.sha256.slice(0, 12);
        backup = join(targetRoot, ".hra-skillpack-backups", `${item.name}-${timestamp()}-${suffix}`);
        await copyTreeOverlay(item.destination, backup);
      }
      await copyTreeOverlay(item.source, item.destination);
      applied.push({ name: item.name, action: item.action, backup });
    }
  }
  const report = { operation: "adopt", mode: args.apply ? "apply" : "preview", source: sourceRoot, target: targetRoot, repair: Boolean(args.repair), changed: applied.length > 0, plan: plan.map(({ comparison, ...item }) => ({ ...item, state: comparison.state, changed: comparison.changed ?? [], missing: comparison.missing ?? [], extra: comparison.extra ?? [] })), applied };
  if (args.json) printJson(report);
  else {
    process.stdout.write(`${report.mode}: ${plan.length} skill(s); ${applied.length} changed\n`);
    for (const item of report.plan) process.stdout.write(`${item.name}: ${item.action}\n`);
    for (const item of applied.filter((entry) => entry.backup)) process.stdout.write(`${item.name}: backup ${item.backup}\n`);
  }
  return report;
}

if (import.meta.main) main().catch((error) => { console.error(`adoption failed: ${error.message}`); process.exitCode = 1; });
