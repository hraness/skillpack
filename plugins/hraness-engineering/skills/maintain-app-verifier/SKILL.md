---
name: maintain-app-verifier
description: Audit and correct drift in an existing project-local application verifier, its driver, and references/features map using source and live evidence. Use when a verify-app skill already exists; do not use to create one, change product code, or treat a product regression as documentation drift.
---

# Maintain an application verifier

Keep an existing verifier honest without expanding its ownership.

## Locate and bound

Find the project-local `verify-<app>` skill with Doctor, Launch, Drive, Evidence, Cleanup, and `references/features/`. If none exists, stop and recommend creating one. If several match, resolve the target before editing.

Only change files owned by the verifier. Do not change product behavior. A product path that is broken is a reported regression, not a reason to rewrite the map to claim the broken behavior is correct.

## Audit

1. Check the feature index against its sibling files and recent user-facing changes.
2. Trace every mapped feature to current source. Use bounded independent readers when that improves coverage, but do not introduce a scheduler.
3. Reconcile likely drift and group live recipes into the fewest safe application states.
4. One coordinator owns the live instance. Run doctor before the first drive, after surprising behavior, and for each fresh session when sessions are isolated.
5. Exercise every feature at least once or record the exact account, entitlement, OS, external-state, or driver prerequisite that makes it unreachable.
6. Fix confirmed map, instruction, or driver drift. Re-drive every driver fix and every changed recipe.
7. Tear down owned processes and scratch state after the last proof. Confirm evidence remains.

Preserve disposable profiles and exact ownership rules from the verifier. Never substitute a person's live profile or shared production state to improve coverage.

## Outcome

Report one outcome:

- **Clean:** source and live coverage completed; no useful change.
- **Changed:** verified corrections are ready under the verifier directory.
- **Blocked:** coverage or safe correction could not complete, with the exact blocker.

Include covered, unreachable, drifted, and regression findings. This skill owns verifier drift, not verifier creation or product fixes.
