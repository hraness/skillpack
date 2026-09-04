# Hraness Agent Skills contributor instructions

This repository is a public, cross-agent skills distribution for Codex, Cursor, and other Agent Skills-compatible hosts.

## Product boundaries

- Keep skill ownership mutually exclusive and collectively useful. Every discoverable skill must say both when to use it and when not to use it.
- `hraness-engineering` owns bounded engineering analysis, verification, testing, performance, documentation, and behavior-preserving refactors.
- `code-orchestrator` owns multi-phase repository delivery after a phase plan exists. It must not replace the HRA host scheduler, repository gates, CI, or merge policy.
- `semantic-algos` owns explicit semantic or reasoning transforms. It must not implicitly route ordinary coding, delivery, or repository-analysis work.
- `skillpack-admin` owns installation-state auditing, adoption, drift detection, and repair of this distribution. It is not an HRA product skill and does not own product coding tasks.
- Preserve useful agent fan-out. Do not introduce a second compute scheduler or cap agents merely to reduce count.
- Do not add cloud execution or cloud optimization to this repository.

## Portability

- Use the Agent Skills directory and `SKILL.md` format as the canonical source.
- Keep host-specific metadata thin. Shared instructions must not hard-code model names, private machine paths, or one host's tool spelling.
- Use repository-relative paths in checked artifacts. Runtime scripts must resolve paths from their own location or an explicit argument.
- Skills that mutate repositories must preserve unrelated work and follow the target repository's own validation and delivery gates.

## Provenance and licensing

- Every adapted skill must have an entry in `sources.lock.json` with an exact source revision and path.
- Lauren Tan's PStack material is MIT-licensed and must retain attribution.
- Rob Cheung's `semantic-algos` material is included with the author's permission and attribution. Do not describe it as MIT-licensed unless the upstream licensing changes and the lock is reviewed.
- `code-orchestrator` adaptations must retain the pinned upstream MIT attribution.
- The repository MIT license covers original Hraness material only; third-party notices and source-specific terms remain controlling for adapted material.

## Validation

- Run the focused checks for paths you change, then `bun run check` for the final converged tree.
- The final repository-wide check should use `hra-host-run` when installed, following the HRA local-efficiency policy.
- Do not weaken validators to make generated or imported content pass. Fix the content or record a narrowly justified exception.

<!-- hra-local-efficiency:start -->
- Treat the user's request to change this repository as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, deployments, and production verification after the repository's required validation, review, identity, and rollout gates pass. Do not ask for another confirmation at each delivery step.
- Use the repository's documented delivery workflow and preserve every runtime-enforced approval, branch protection, environment rule, safety policy, and final gate. Ask for user input only when delivery needs a material product decision, missing credentials or authority, an irreversibly destructive action outside task scope, or resolution of a release failure that cannot be handled safely and autonomously.
- Prefer short-lived repository workload identities such as OIDC trusted publishing, GitHub Apps, and narrowly scoped machine identities. Do not add long-lived personal tokens, weaken two-factor authentication, or bypass provider controls to eliminate an interactive prompt. Batch unavoidable human-gated production promotions into intentional stable releases while agents publish validated prerelease or beta channels through workload identities when the repository supports them.
- Preserve useful reasoning fan-out, but avoid unnecessary checkout fan-out. Prefer subagents in the current task for bounded research, review, diagnosis, and focused checks when they can safely share one working tree; create a separate task or worktree only for independently deliverable divergent edits, an isolated verification tree, or a different execution environment.
- Give each expensive focused validation command and external wait one owner. The integration owner reviews that evidence and runs the repository-required aggregate or final gate once after convergence. Reuse evidence only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and validity period, and never to skip a required final integration, merge, release, deployment, or production-verification gate.
- On Hraness development machines, use `$hra-local-efficiency` and the installed host scheduler for heavyweight top-level commands when available. Keep ordinary work in the compute lane; give authenticated browser/dev-server/Chromium work one `browser-auth` owner and Mac-only validation one `mac-native` owner.
- When a CI or policy gate scans complete Git history, check out the exact governed SHA and fetch only the fully qualified governed refs before scanning. Preserve the complete-history gate and reject unexpected refs instead of importing unrelated concurrent heads.
- At closeout, record applicable branch, PR, check, merge, release, deployment, and production evidence. Archive only conclusively finished tasks, never from silence alone, and reclaim only freshly revalidated clean merged worktrees through the guarded exact-path flow.
<!-- hra-local-efficiency:end -->
