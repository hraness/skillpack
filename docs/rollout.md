# Hraness rollout and duplicate retirement

The shared marketplace is the machine-wide source of reusable workflows.
Repository-local skills remain appropriate only when they encode behavior,
commands, or policy specific to that repository.

## 2026-09-01 local sample

A read-only machine audit of 27 Git repositories found 48 repository-local
directories whose names collide with this pack:

- 23 `phase-orchestrator` copies;
- 1 `write-phase-plan` copy;
- 24 semantic-operator copies across Jungle, the personal monorepo template,
  and TIFF.

Every collision was `drift`, not an exact tree match. Most orchestration copies
still expose worker roles separately or lack the consolidated reference
protocol. Existing semantic copies lack the explicit-only cross-host metadata
and MECE boundaries in this pack. Therefore this release intentionally deletes
or overwrites none of them.

Reproduce the read-only audit on any machine with explicit roots:

```sh
bun plugins/skillpack-admin/scripts/machine-audit.mjs \
  --source /reviewed/skillpack \
  --repos-root /explicit/repositories/root
```

## Adoption sequence

1. Add the public `hraness/skillpack` marketplace to Codex and install only the
   versioned plugins needed on that host. Before public Cursor approval, use a
   Teams/Enterprise team import or explicitly reviewed local plugin links; retain
   any authorized direct semantic setup until `semantic-algos` has a
   Cursor-accepted permissive license.
2. Start a fresh agent task so the host reloads plugin metadata.
3. Run `$skillpack-admin` in audit mode. Record marketplace revision, installed
   plugin versions, and repository-local name collisions.
4. Prefer namespaced shared skills for new work. Keep repository copies in
   place until their repository-specific instructions are classified.
5. Retire a local copy through that repository's normal reviewed delivery path
   only after its useful deltas are either moved into repository instructions
   or intentionally incorporated here. Never bulk-delete drifted copies.
6. After a repository has retired a shared duplicate, add a focused check that
   prevents that exact generic skill from being vendored again while allowing
   truly project-specific verifier skills.

## Ownership after migration

- Shared pack: generic procedure, routing boundary, attribution, host metadata,
  and portable references.
- Target repository: commands, gates, delivery policy, app-specific verifier,
  and repository-only domain knowledge.
- Local efficiency: machine resource scheduling, capability lanes,
  validation receipts, worktree custody, and throughput telemetry.
- Host marketplace: installation state and version selection.

This split preserves useful agent fan-out and repository gates while removing
the need to synchronize dozens of copied generic workflows by hand.
