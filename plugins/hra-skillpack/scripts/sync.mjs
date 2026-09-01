#!/usr/bin/env bun
import { main } from "../skills/hra-skillpack/scripts/sync.mjs";

main().catch((error) => { console.error(`sync failed: ${error.message}`); process.exitCode = 1; });
