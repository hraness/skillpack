---
name: phase-orchestrator
description: >-
  Execute an existing multi-phase repository plan with bounded implementation
  workers, independent review, join gates, validation, and final integration.
  Use when the user explicitly asks for delegated or multi-agent execution of
  a phase plan. Do not use for ordinary single-owner coding, plan authoring,
  semantic reasoning, or as a replacement for Oompa scheduling and repo gates.
license: MIT
---

# Phase Orchestrator

Run the plan as the source of truth. Read the target repository's instructions,
current status, applicable spec, and delivery policy before dispatching work.

Read [references/orchestration-protocol.md](references/orchestration-protocol.md)
before execution. Load a worker protocol only immediately before dispatching
that role:

- [implementer](references/workers/implementer.md)
- [reviewer](references/workers/reviewer.md)
- [final reviewer](references/workers/final-reviewer.md)

The worker protocols are internal references, not discoverable skills.

Preserve useful fan-out when phases have disjoint ownership. Give shared
manifests, lockfiles, registries, generated outputs, and final integration one
owner. Use one owner for each external CI, deployment, or provider wait.

The target repository remains authoritative for tests, CI, commits, merge,
release, and deployment. This skill never creates a second compute scheduler.
When Oompa local efficiency is installed or required, route broad and final work
through its documented host wrapper and lane while preserving the exact child
command. Never bypass the wrapper, weaken the gate, or hold a compute lease
while waiting on external state.

Complete only the phases and delivery steps the user placed in scope. Preserve
unrelated work and report exact validation and delivery evidence.
