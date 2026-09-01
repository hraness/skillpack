# Code Orchestrator

**Turn an approved direction into reviewable, dependency-ordered delivery.**

Code Orchestrator contributes two portable Agent Skills: one prepares an
implementation-ready phase plan; the other executes an existing plan through
bounded workers, independent review, join gates, and final integration.

## First proof

Ask:

> Turn this approved architecture into an implementation-ready phase plan.

`write-phase-plan` returns ordered phases with explicit ownership, write
scopes, acceptance criteria, dependencies, validation, and integration
responsibility. It does not begin implementation or reopen the architecture
decision.

## How it works

```text
approved direction → phase plan → bounded implementation → independent review → join gate → final integration
```

| Skill | Result |
| --- | --- |
| `write-phase-plan` | A context-complete, dependency-ordered plan that independent workers can execute |
| `phase-orchestrator` | Reviewed phase delivery with worker receipts, repairs, status, and one final integration result |

Worker roles live under `phase-orchestrator/references/workers/`. They are
protocol references, not discoverable skills, so implementer and reviewer
roles cannot compete with the parent workflow during routing.

## Interfaces

The canonical interfaces are `skills/write-phase-plan/SKILL.md` and
`skills/phase-orchestrator/SKILL.md`. Host manifests expose those same sources
in Codex, Cursor, Copilot, and Agent Plugins-compatible environments.

## Evidence

- [`skills/write-phase-plan/references/plan-contract.md`](skills/write-phase-plan/references/plan-contract.md)
  defines the plan shape and join criteria.
- [`skills/phase-orchestrator/references/orchestration-protocol.md`](skills/phase-orchestrator/references/orchestration-protocol.md)
  defines execution, review, convergence, and final integration.
- Separate implementer, reviewer, and final-reviewer references preserve
  independent ownership.
- The repository’s routing fixtures distinguish phased delivery from ordinary
  one-owner work, unresolved architecture, and host scheduling.

Attribution and pinned upstream sources are recorded in
[`PROVENANCE.md`](PROVENANCE.md).

## Boundaries

- Use phased delivery only when an implementation direction is already chosen
  and the work has independently deliverable phase boundaries.
- Do not fan out a one-line fix or other ordinary one-owner task.
- Resolve open architecture choices before plan authoring or execution.
- The plugin coordinates reasoning and ownership only. It never replaces the
  target repository’s `AGENTS.md`, compute scheduler, validation, CI, review,
  merge, release, or deployment policy.

## Questions

### Do I need a phase plan before execution?

Yes. Use an existing implementation-ready plan or create one with
`write-phase-plan`; `phase-orchestrator` does not improvise a hidden plan.

### Are implementer and reviewer separate skills?

No. They are bounded worker protocols inside `phase-orchestrator`, which keeps
the user-facing routing surface to exactly two skills.

### Does the orchestrator own machine capacity?

No. It preserves the host scheduler and gives each heavyweight command or
external wait one owner.

## Start

Review the plan contract or orchestration protocol, then install
`code-orchestrator` through one of the supported paths in the
[`Hraness Agent Skills` README](../../README.md#install-in-the-host-you-already-use).
