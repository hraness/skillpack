---
name: semantic-code-analysis
description: Explain how a code path or subsystem behaves now by tracing entry points, data flow, state, boundaries, failures, and verification evidence. Use for current-behavior questions; do not use to reconstruct historical intent, estimate change blast radius, or implement a fix.
license: MIT
---

# Semantic code analysis

Answer the concrete behavior question from source and, where useful, read-only runtime evidence.

## Analysis

1. Restate the behavior or invariant being investigated and bound the relevant surface.
2. Find the real entry points and callers before reading implementation details in isolation.
3. Trace inputs through transformations, state changes, concurrency boundaries, side effects, outputs, and failure paths.
4. Identify authoritative types, schemas, registries, configuration, and lifecycle ownership.
5. Use tests and runnable probes to confirm disputed or non-obvious behavior. Do not mutate product code unless the user separately asks for a change.
6. Check alternate paths such as retries, cancellation, empty state, feature gates, and cleanup when they affect the answer.

Prefer evidence from the exact working tree. Cite file paths and symbols precisely. Label deductions as inferences and say what evidence would resolve remaining uncertainty.

## Deliverable

Lead with the answer. Then give the shortest useful execution narrative, key invariants, failure behavior, and evidence. Include a diagram only when multiple components or state transitions are materially clearer visually.
