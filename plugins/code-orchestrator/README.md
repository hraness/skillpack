# Code Orchestrator

Code Orchestrator is two Agent Skills for repository work that needs several
phases. One writes an implementation-ready phase plan from a direction you
already chose. The other carries out an existing plan: separate workers
implement each phase, independent reviewers check it, and one final
integration brings the phases together.

## Try it

Ask:

> Turn this approved architecture into an implementation-ready phase plan.

`write-phase-plan` returns ordered phases, each with an owner, the files it
may change, acceptance criteria, dependencies, validation, and who integrates
it. It stops after the plan; it does not start implementation or reopen the
architecture decision.

## How it works

```text
approved direction → phase plan → implementation → independent review → phase join → final integration
```

| Skill | Result |
| --- | --- |
| `write-phase-plan` | A dependency-ordered plan with enough context that workers without the conversation can carry it out |
| `phase-orchestrator` | Reviewed phase delivery with a report from each worker, repairs, status, and one final integration result |

Worker roles live under `phase-orchestrator/references/workers/`. They are
reference files, not skills an agent can discover, so the implementer and
reviewer roles never compete with the parent skill for a request.

## Interfaces

The two skills are `skills/write-phase-plan/SKILL.md` and
`skills/phase-orchestrator/SKILL.md`. Host manifests expose the same files in
Codex, Cursor, Copilot, and Agent Plugins hosts.

## Checks

- [`skills/write-phase-plan/references/plan-contract.md`](skills/write-phase-plan/references/plan-contract.md)
  defines the plan format and when phases can join.
- [`skills/phase-orchestrator/references/orchestration-protocol.md`](skills/phase-orchestrator/references/orchestration-protocol.md)
  defines execution, review, convergence, and final integration.
- Separate implementer, reviewer, and final-reviewer references keep review
  independent of implementation.
- The repository’s routing fixtures separate phased delivery from ordinary
  single-owner work, open architecture questions, and host scheduling.

Attribution and pinned upstream sources are recorded in
[`PROVENANCE.md`](PROVENANCE.md).

## Limits

- Use phased delivery only when the implementation direction is already
  chosen and the work splits into phases that can be delivered separately.
- Do not fan out a one-line fix or other ordinary single-owner task.
- Settle open architecture choices before writing or running the plan.
- The plugin plans the work and assigns each part one owner. It never replaces
  the target repository’s `AGENTS.md`, compute scheduler, validation, CI,
  review, merge, release, or deployment policy.

## Questions

### Do I need a phase plan before execution?

Yes. Use an existing implementation-ready plan or create one with
`write-phase-plan`; `phase-orchestrator` does not make up a plan of its own.

### Are implementer and reviewer separate skills?

No. They are worker instructions inside `phase-orchestrator`, so an agent
choosing a skill sees exactly two.

### Does the orchestrator manage machine capacity?

No. It leaves scheduling to the host and gives each heavy command or external
wait one owner.

## Start

Read the plan contract or the orchestration protocol, then install
`code-orchestrator` through one of the paths in the
[`Hraness Agent Skills` README](../../README.md#install-in-the-host-you-already-use).
