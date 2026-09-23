# Hraness Engineering

Hraness Engineering is 11 Agent Skills for work in one repository:
understanding code, verifying the running app, writing tests, updating docs,
measuring performance, and refactoring without changing behavior. Each skill
produces one kind of result, so the agent can pick the right one and analysis
stays separate from implementation and delivery.

## Try it

Ask:

> Map this repository’s user-visible features and where each is tested.

`repository-feature-map` returns a map of the repository’s domains, entry
points, runtime flows, data ownership, and the tests and checks that cover
them. It maps the code as it is now; it does not plan changes or guess at
historical intent.

## How it works

```text
task → one engineering skill → the repository’s own sources and commands → a checked result
```

| Skill | Result |
| --- | --- |
| `repository-feature-map` | A map of repository domains, entry points, flows, and the checks that cover them |
| `semantic-code-analysis` | An explanation of how code behaves now, with the evidence for each point |
| `reconstruct-rationale` | A dated reconstruction of why code reached its current shape, with a confidence level for each finding |
| `assess-change-impact` | A register of what a defined change could break and which compatibility risks it carries |
| `compare-approaches` | A comparison of workable technical approaches, ready for a decision |
| `create-app-verifier` | A new project-local skill that safely drives the real application and checks its behavior |
| `maintain-app-verifier` | Corrections to an existing verifier and feature map after the source or the live app changed |
| `test-engineer` | A focused test strategy, reproduction, implementation, and regression tests |
| `performance-investigator` | A measured performance diagnosis with before and after numbers |
| `docs-maintainer` | Documentation that matches current behavior, commands, and interfaces |
| `refactor-maintainer` | A structural change that keeps behavior the same, states what must not change, and migrates every caller |

The selected skill reads the target repository’s instructions and uses its
existing commands and conventions. Analysis skills stop before changing code.
Implementation skills leave unrelated work alone and run the focused checks
plus the checks the repository requires.

## Interfaces

Each skill lives in its own `skills/<name>/SKILL.md` directory. Codex, Cursor,
Agent Plugins hosts, and registry listings read those same files through small
manifests. You don’t need a Hraness account, app, or service.

## Checks

- Every skill says when to use it and when not to.
- [`../../catalog/catalog.json`](../../catalog/catalog.json) records the owner
  and the neighboring skills for every workflow.
- [`../../catalog/routing-fixtures.json`](../../catalog/routing-fixtures.json)
  lists positive, negative, and paired routing cases.
- The repository check validates portable paths, host metadata, provenance,
  and the exact list of discovered skills.

Third-party source history and licensing are recorded in
[`PROVENANCE.md`](PROVENANCE.md).

## Limits

- These skills do not run a multi-phase delivery plan; use
  `code-orchestrator` for that.
- They do not apply a reasoning method to a business or writing question
  unless you ask; name a `semantic-algos` skill instead.
- They do not replace repository instructions, application-specific policy,
  host scheduling, CI, review, merge, release, or deployment rules.
- A real product regression is product work, even when a verifier or a
  documentation check is what exposed it.

## Questions

### Which skill should I use to understand code?

Use `repository-feature-map` for broad navigation,
`semantic-code-analysis` for one current code path, and
`reconstruct-rationale` only when the question is why the code was written
that way.

### Will an analysis skill implement its recommendation?

No. Analysis skills report what they found and stop. Use an implementation
skill only when the request includes the change.

### Does the pack decide my repository’s final checks?

No. The target repository’s instructions and delivery workflow decide them.

## Start

Read the skill for the result you want, then install `hraness-engineering`
through one of the paths in the
[`Hraness Agent Skills` README](../../README.md#install-in-the-host-you-already-use).
