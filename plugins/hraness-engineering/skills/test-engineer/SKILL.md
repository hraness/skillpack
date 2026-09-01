---
name: test-engineer
description: Design, implement, or repair focused automated tests that reproduce behavior and provide reliable regression evidence at the right layer. Use for test strategy and test-code work; do not use to create an application-driving skill, perform performance tuning, or change product behavior beyond an explicitly requested fix.
---

# Test engineer

Build the smallest trustworthy test surface for the behavior at risk.

## Choose the evidence layer

Start from the externally observable behavior or invariant. Reuse the repository's test framework and helpers. Choose the lowest layer that still crosses the boundary where the bug or contract lives:

- Unit tests for pure logic and local invariants.
- Integration or contract tests for boundaries, persistence, protocols, and component interaction.
- End-to-end tests for user journeys that lower layers cannot faithfully prove.

Do not create a project-wide app harness here. If repeatable real-app driving infrastructure is missing, identify that gap separately.

## Work

1. Reproduce the failure before fixing it when the task includes a bug fix.
2. Name the causal condition and expected observable result.
3. Cover the meaningful success and failure paths without mirroring implementation details.
4. Control time, randomness, concurrency, network, and shared state at established boundaries. Do not hide a race with broad retries or sleeps.
5. Run the focused test before and after the change when possible, then the repository-required affected or aggregate gates.
6. Inspect failures rather than weakening assertions. Preserve unrelated tests and user changes.

## Report

State the behavior covered, test layer, command and result, regression signal, and known gaps. Distinguish a test that passes from behavior proved on a real application when those are different claims.
