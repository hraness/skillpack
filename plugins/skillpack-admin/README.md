# Hraness Skillpack Admin

**Know what is installed before you change it.**

Skillpack Admin is the optional lifecycle tool for this distribution. It can
audit the source or an explicit destination, preview adoption, detect drift,
and perform a backup-first repair without deleting extra destination files.

## First proof

Run a read-only source audit:

```sh
bun scripts/audit.mjs --root ../..
```

The result inventories discovered skills and reports validation or destination
state without writing files.

## How it works

```text
audit → explicit destination → preview → backup-first apply → re-audit
```

| Operation | Result | Writes? |
| --- | --- | --- |
| Audit | Source validation or `match`, `missing`, and `drift` inventory | No |
| Machine audit | Repository-local name collisions under one explicit repositories root | No |
| Adopt | A preview or copy of explicitly selected skills into an explicit destination | Only with `--apply` |
| Sync | The all-discovered-skills form of adoption | Only with `--apply` |
| Repair | A reviewed overlay after a sibling backup | Only with `--repair --apply` |

## Interfaces

Use the `$skillpack-admin` Agent Skill for guided operation or call the bundled
`audit.mjs`, `machine-audit.mjs`, `adopt.mjs`, and `sync.mjs` scripts directly
with explicit roots. The scripts require Bun 1.3 or a Node.js 24-compatible
runtime.

## Evidence

- Preview is the default for adoption.
- Repair refuses symbolic links and path escapes.
- A complete sibling backup is created before a reviewed repair overlays
  known source files.
- Offline canaries prove read-only preview, adoption, drift handling, backup,
  extra-file preservation, and symbolic-link refusal.

## Boundaries

- The tool manages this skill distribution; it does not operate or configure
  the HRA product.
- It does not infer a personal skills directory. Supply the source and
  destination explicitly.
- It does not edit marketplace configuration, install network dependencies,
  fetch upstream sources, delete user skills, or route product coding work.
- A `drift` result is a variant to review, not permission to overwrite it.

## Questions

### Is audit safe to run first?

Yes. Audit and machine audit are read-only. Report the exact roots and results
before considering adoption or repair.

### Does repair remove files that are not in the pack?

No. It overlays reviewed source files after creating a backup and leaves extra
destination files for explicit disposition.

### Is this an HRA administration plugin?

No. Hraness publishes the pack, but this plugin manages only the pack’s
installation state.

## Start

Read [`skills/skillpack-admin/SKILL.md`](skills/skillpack-admin/SKILL.md), run a
read-only audit, and install the optional plugin only if you manage this
distribution. Host-specific installation paths are documented in the
[`Hraness Agent Skills` README](../../README.md#install-in-the-host-you-already-use).
