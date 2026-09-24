# Phase plan contract

Use a repository-native document shape when one exists. Otherwise use this
portable structure:

```markdown
# Feature

## Outcome
What changes and why.

## Constraints
Repository rules, preserved behavior, delivery policy, and shared ownership.

## Phase map
| Phase | Outcome | Depends on | Write scope | Parallel with |

## Phase 1: Name
- **Status:** Not started
- **Depends on:** none
- **Objective:** one observable outcome
- **Scope:** owned files or modules
- **Out of scope:** adjacent work
- **Approach:** decided implementation constraints and starting points
- **Acceptance criteria:** observable, checkable statements
- **Validation:** exact focused commands and any manual evidence

## Implementation log
```

## Phase design

- One phase should end in validated, reviewable work.
- Put schema or migration work in an explicit phase when it changes downstream
  contracts or delivery risk.
- Parallel phases require disjoint write scopes. Give manifests, lockfiles,
  registries, and generated convergence artifacts one owner.
- Record unresolved decisions as open questions with a named resolver; do not
  hide them in approach prose.
- Include negative acceptance criteria when preserving an existing contract,
  performance budget, or production boundary matters.

## Validation design

Name focused checks for each phase and the repository's aggregate/final gate
after convergence. Never substitute a weaker public command. If a host
lane applies, record the lane separately from the unchanged child command.

## Runtime updates

The orchestrator owns status transitions to `In progress`, `Done`, `Partial`,
or `Blocked`. Each log entry records the date, phase, behavior, validation,
review outcome, commits or PRs when applicable, deviations, and remaining
risks.
