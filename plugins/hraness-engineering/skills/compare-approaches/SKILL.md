---
name: compare-approaches
description: Compare viable technical approaches against explicit constraints and evidence, producing a decision-ready recommendation. Use when a real architecture or implementation choice remains open; do not use when the answer is observable from the existing system, when one approach is already required, or to implement the winner.
---

# Compare approaches

Resolve a genuine technical choice without turning preference into evidence.

## Frame

Name the decision, non-negotiable constraints, success measures, and repository precedents. If the question can be answered by inspecting or running the current system, do that instead of inventing alternatives.

## Compare

1. Keep only viable approaches. Include the current design when retaining it is credible.
2. Normalize each option to comparable scope and evaluate behavior, complexity, operability, migration, reversibility, testability, performance, and maintenance cost.
3. Cite repository evidence for assumptions. Label values that require measurement.
4. When a consequential uncertainty is cheaply observable, build or run the smallest isolated probe the user has authorized. Keep experimental outputs separate and disposable.
5. Prefer fewer moving parts when outcomes are equivalent. Do not preserve compatibility layers unless a real consumer requires them.

Parallel exploration can help independent designs, but this skill neither requires fan-out nor owns scheduling. Follow the host and repository's existing coordination rules.

## Deliverable

Give a compact comparison table, decisive tradeoffs, recommendation, conditions that would change it, and unresolved evidence. Do not implement the selected option unless the user asks for implementation.
