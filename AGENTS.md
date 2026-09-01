# Hraness Skillpack contributor instructions

This repository is a public, cross-agent skills distribution for Codex, Cursor, and other Agent Skills-compatible hosts.

## Product boundaries

- Keep skill ownership mutually exclusive and collectively useful. Every discoverable skill must say both when to use it and when not to use it.
- `hraness-engineering` owns bounded engineering analysis, verification, testing, performance, documentation, and behavior-preserving refactors.
- `code-orchestrator` owns multi-phase repository delivery after a phase plan exists. It must not replace the HRA host scheduler, repository gates, CI, or merge policy.
- `semantic-algos` owns explicit semantic or reasoning transforms. It must not implicitly route ordinary coding, delivery, or repository-analysis work.
- `hra-skillpack` owns installation, auditing, adoption, drift detection, and repair of this pack. It does not own product coding tasks.
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
