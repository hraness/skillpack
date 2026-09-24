# Orchestration protocol

## Orient

1. Read the plan, repository guidance, specs, git status, and applicable
   validation and delivery rules.
2. Resolve dependencies, write scopes, convergence files, and the requested
   stopping point.
3. Keep one orchestration step in progress. Treat pre-existing changes as
   user-owned unless provenance proves otherwise.

## Choose a topology

- Default: one implementer, focused validation, then one independent reviewer.
- Batch migration: inventory first, disjoint workers by batch, aggregate
  validation, then one reviewer over the combined result.
- Audit: parallel read-only slices, independent confirmation, then deduplicate.
- Fix until green: bounded repair rounds with an explicit attempt ceiling or
  no-progress stop.
- Competing designs: independent drafts, comparison, then one selected design
  before implementation.

Parallel workers must have disjoint write scopes. Do not cap useful reasoning
lanes merely to reduce their count.

## Phase loop

1. Mark the phase in progress and load the implementer protocol.
2. Dispatch the worker with the plan, exact phase, prior evidence, repo rules,
   ownership, dirty-tree notes, validation, and commit policy.
3. Inspect the result, actual diff, and status. Run the phase's focused checks.
4. Load the reviewer protocol and dispatch an independent review against the
   plan, acceptance criteria, actual change, and validation evidence.
5. Validate review fixes. Commit or deliver only through the repository's own
   documented workflow and only when authorized by the task and repo policy.
6. Update phase status and the implementation log with exact evidence.

Do not repeat a focused command whose exact inputs did not change and whose
evidence is complete. Run the repository's required aggregate/final gate after
the complete tree converges.

## HRA scheduling boundary

This protocol schedules people and reasoning, not machine resources. If the
target instructions require `hra-host-run`, resolve and invoke that documented
wrapper with the complete unchanged child command and correct lane. Do not run
the child directly after a host-access failure, add an unconditional approval,
or weaken a repository scheduler nested below it.

## Final integration

After all requested phases:

1. Run the required aggregate/final gate once on the converged tree.
2. Load and dispatch the final reviewer against the complete change.
3. Validate any final fixes and repeat a required gate only when those fixes
   invalidate its evidence.
4. Follow the repo's merge, release, deployment, and production-readback rules
   that are within scope.
5. Report phases, changed behavior, exact commands/results, commits or PRs,
   final branch state, and remaining risks.

## Worker result contract

Require these headings in order:

1. `Outcome`
2. `Changed files`
3. `Behavior or findings`
4. `Validation`
5. `Downstream impact`
6. `Blockers and risks`

Workers do not commit unless the dispatch explicitly delegates commit
authority. The parent remains the integration owner.
