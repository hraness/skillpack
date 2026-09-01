#!/usr/bin/env bun
import { main } from "../skills/hra-skillpack/scripts/machine-audit.mjs";

main().catch((error) => { console.error(`machine audit failed: ${error.message}`); process.exitCode = 1; });
