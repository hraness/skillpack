---
name: write-phase-plan
description: >-
  Write or restructure a dependency-ordered implementation plan for later
  multi-agent execution, with explicit phase ownership, acceptance criteria,
  validation, and status logging. Use when the user asks for a phased plan or
  a plan consumable by phase-orchestrator. Do not use to execute the plan or
  replace a repository's own planning and delivery rules.
---

# Write Phase Plan

Produce a plan that a worker with no conversation history can implement using
the plan, the repository, and the repository's own instructions.

Before writing, read the target repository's `AGENTS.md` files and applicable
planning conventions. Preserve the user's requested output location. Do not
invent a new plan directory when the repository already defines one.

Read [references/plan-contract.md](references/plan-contract.md) and apply it to
the requested work.

The plan must:

- state the outcome and non-goals;
- separate phases by independently verifiable deliverable, not by activity;
- declare dependencies and disjoint write ownership;
- identify shared or convergence files that need one integration owner;
- include checkable acceptance criteria and exact repository validation;
- record the repository's commit, PR, merge, release, and deployment policy
  without weakening or replacing it;
- mark every phase `Not started` and include an empty implementation log.

Do not mark overlapping phases parallel. Do not add a new scheduler. When the
repository uses HRA local efficiency, record its required host lane for broad
or final checks without rewriting the underlying repository command.

Stop after writing or updating the plan unless the user also asks to execute
it.
