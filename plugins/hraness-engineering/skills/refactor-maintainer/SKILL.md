---
name: refactor-maintainer
description: Perform behavior-preserving structural changes with an explicit invariant, caller migration, deletion of obsolete paths, and focused plus repository-required validation. Use for refactors and internal migrations; do not use for feature work, intentional behavior changes, speculative cleanup, or performance changes without measurement.
license: MIT
---

# Refactor maintainer

Improve structure while preserving the behavior the repository and its consumers rely on.

## Define the contract

Name the invariant, affected callers, public or compatibility boundaries, and evidence that represents current behavior. If the desired result changes behavior, route it as feature or bug work instead of calling it a refactor.

## Refactor

1. Read repository rules and inspect the working tree. Preserve unrelated changes.
2. Find all callers and representations of the old shape before introducing the new one.
3. Prefer deletion, directness, smaller mutable scope, and an authoritative data structure over new abstraction layers.
4. Sequence the work into small states that each compile or pass focused checks. Migrate internal callers and remove the obsolete internal API in the same completed wave when compatibility does not require coexistence.
5. Preserve public and cross-version compatibility when it is a real requirement. Do not remove a legacy surface merely because no in-repository caller remains.
6. Run focused checks after each meaningful unit and the target repository's required final gate after convergence.

If validation exposes an existing product bug or the invariant is ambiguous, stop the structural change at a safe state and report the product decision separately.

## Report

State the preserved invariant, structural simplification, callers migrated, obsolete code removed, exact validation, and any compatibility surface intentionally retained.
