---
name: docs-maintainer
description: Create or update repository documentation so commands, behavior, examples, navigation, and operational guidance match authoritative current sources. Use for README, guide, reference, runbook, or release-documentation maintenance; do not use for general copywriting, historical rationale, or product-code changes.
license: MIT
---

# Documentation maintainer

Make repository documentation accurate, findable, runnable, and proportionate to its audience.

## Establish authority

Read repository documentation rules and identify the source of truth for each claim: code, schema, command help, configuration, API contract, tests, release metadata, or operational policy. Determine the document type and reader task before choosing structure.

## Maintain

1. Trace affected claims and inbound links before editing or moving content.
2. Update the smallest coherent documentation surface. Remove stale duplication rather than synchronizing multiple weak copies.
3. Keep procedures ordered, prerequisites explicit, examples literal, and warnings adjacent to risky steps.
4. Use terminology and paths that readers can search in the repository. Separate conceptual explanation, task instructions, reference facts, and troubleshooting when mixing them would slow the reader.
5. Run documented commands in a safe environment when practical. Validate snippets, links, anchors, generated references, and version statements with repository tools.

Do not change product code to make documentation true unless the user separately requested that product change. Record a behavior mismatch instead.

## Report

Summarize the reader-facing correction, authoritative evidence, validation commands and results, and any claims that remain conditional or unverified.
