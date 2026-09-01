#!/usr/bin/env bun
import { main } from "../skills/hra-skillpack/scripts/adopt.mjs";

main().catch((error) => { console.error(`adoption failed: ${error.message}`); process.exitCode = 1; });
