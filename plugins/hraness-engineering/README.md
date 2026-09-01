# Hraness Engineering

**Get evidence before you change the repository.**

Hraness Engineering is 11 bounded Agent Skills for understanding, verifying,
testing, documenting, measuring, and safely refactoring one repository
concern. Each workflow owns a distinct result, so the agent can choose a method
without blurring analysis, implementation, and delivery.

## First proof

Ask:

> Map this repository’s user-visible features and proof paths.

`repository-feature-map` returns a navigable map of domains, entry points,
runtime flows, data ownership, and validation surfaces. It does not turn the
request into an implementation project or invent historical rationale.

## How it works

```text
task → bounded engineering owner → authoritative repository sources → focused proof
```

| Skill | Result |
| --- | --- |
| `repository-feature-map` | A navigable map of repository domains, entry points, flows, and validation surfaces |
| `semantic-code-analysis` | An evidence-backed explanation of how code behaves now |
| `reconstruct-rationale` | A dated, confidence-calibrated reconstruction of why code reached its current shape |
| `assess-change-impact` | A blast-radius and compatibility-risk register for a defined change |
| `compare-approaches` | A decision-ready comparison of viable technical approaches |
| `create-app-verifier` | A new project-local skill that safely drives and proves the real application |
| `maintain-app-verifier` | A source-and-live drift correction for an existing verifier and feature map |
| `test-engineer` | Focused test strategy, reproduction, implementation, and regression evidence |
| `performance-investigator` | Measurement-led performance diagnosis and before/after proof |
| `docs-maintainer` | Documentation aligned to authoritative current behavior, commands, and contracts |
| `refactor-maintainer` | Behavior-preserving structural change with an explicit invariant and complete caller migration |

The selected skill reads the target repository’s instructions and uses its
existing commands and conventions. Analysis-only skills stop before changing
code; implementation skills preserve unrelated work and run focused plus
repository-required validation.

## Interfaces

The canonical interface is each `skills/<name>/SKILL.md` directory. Codex,
Cursor, Agent Plugins-compatible hosts, and registry listings discover the
same sources through thin metadata adapters. No HRA application, CLI, account,
or service is required.

## Evidence

- Every skill states both a positive route and a negative boundary.
- [`../../catalog/catalog.json`](../../catalog/catalog.json) records one owner
  and adjacent skills for every workflow.
- [`../../catalog/routing-fixtures.json`](../../catalog/routing-fixtures.json)
  proves positive, negative, and pairwise routing cases.
- Repository validation checks portable paths, host metadata, provenance, and
  the exact discovered skill inventory.

Third-party source history and licensing are recorded in
[`PROVENANCE.md`](PROVENANCE.md).

## Boundaries

- These skills do not coordinate an explicitly multi-phase delivery plan; use
  `code-orchestrator` for that result.
- They do not implicitly apply a semantic transform to a business or writing
  question; invoke a named `semantic-algos` operator instead.
- They do not replace repository instructions, application-specific policy,
  host scheduling, CI, review, merge, release, or deployment gates.
- A real product regression remains product work; it is not verifier or
  documentation drift merely because a proof surface exposed it.

## Questions

### Which skill should I use to understand code?

Use `repository-feature-map` for broad navigation,
`semantic-code-analysis` for one current code path, and
`reconstruct-rationale` only when the question is historical intent.

### Will an analysis skill implement its recommendation?

No. Analysis skills report evidence and stop. Use the appropriate
implementation workflow only when the request includes the change.

### Does the pack define my repository’s final gate?

No. The target repository’s instructions and delivery workflow remain
authoritative.

## Start

Review the skill that owns the requested result, then install
`hraness-engineering` through one of the supported paths in the
[`Hraness Agent Skills` README](../../README.md#install-in-the-host-you-already-use).
