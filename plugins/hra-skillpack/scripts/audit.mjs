#!/usr/bin/env bun
import { main } from "../skills/hra-skillpack/scripts/audit.mjs";

main().catch((error) => { console.error(`audit failed: ${error.message}`); process.exitCode = 1; });
