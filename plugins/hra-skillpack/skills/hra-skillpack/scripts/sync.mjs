#!/usr/bin/env bun
import { main as adopt } from "./adopt.mjs";

export async function main(argv = process.argv.slice(2)) {
  const hasSelection = argv.includes("--all") || argv.includes("--skill");
  return adopt(hasSelection ? argv : [...argv, "--all"]);
}

if (import.meta.main) main().catch((error) => { console.error(`sync failed: ${error.message}`); process.exitCode = 1; });
