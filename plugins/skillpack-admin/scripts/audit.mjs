#!/usr/bin/env bun
import { main } from "../skills/skillpack-admin/scripts/audit.mjs";

main().catch((error) => { console.error(`audit failed: ${error.message}`); process.exitCode = 1; });
