#!/usr/bin/env bun
import { main } from "../skills/skillpack-admin/scripts/adopt.mjs";

main().catch((error) => { console.error(`adoption failed: ${error.message}`); process.exitCode = 1; });
