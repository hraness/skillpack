#!/usr/bin/env bun
import { main } from "../skills/skillpack-admin/scripts/machine-audit.mjs";

main().catch((error) => { console.error(`machine audit failed: ${error.message}`); process.exitCode = 1; });
