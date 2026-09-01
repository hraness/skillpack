---
name: repository-feature-map
description: Build or refresh a navigable, evidence-backed map of a repository's domains, entry points, runtime flows, data ownership, and validation surfaces. Use when someone needs orientation or a maintained repository map; do not use to explain one subsystem in depth, infer historical rationale, or assess a proposed change.
license: MIT
---

# Repository feature map

Produce a compact map that lets a new contributor find where behavior begins, where it is implemented, and how it is verified.

## Scope

Map current repository structure and behavior. Do not infer why the design exists; route that question to rationale reconstruction. Do not turn the map into a change plan or a generated wiki. Write files only when the user asks for a maintained artifact; otherwise return the map in the response.

## Build the map

1. Read repository instructions and existing architecture, ownership, and test documentation.
2. Inventory user-facing surfaces and operational entry points from manifests, routes, commands, services, jobs, packages, and public APIs.
3. Trace each major capability to its owning module, important data or state, external boundary, and strongest verification surface.
4. Group by behavior or domain, not by directory alone. Record cross-domain flows only when they help navigation.
5. Check the map against source and runnable discovery commands. Mark generated, vendored, experimental, or unreachable areas explicitly.

Use this entry shape:

- Capability and user-visible purpose.
- Entry points.
- Owning modules and state.
- Important downstream or external boundaries.
- Tests, harnesses, or runtime checks.
- Confidence and unresolved gaps.

Keep paths searchable and descriptions short. Prefer a top-level index plus focused domain sections over a single exhaustive file list.

## Report

State the inspected revision or working-tree state, coverage boundaries, high-value entry points, and gaps. Separate observed facts from tentative mappings.
