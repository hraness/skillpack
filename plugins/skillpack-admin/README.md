# Hraness Skillpack Admin

Skillpack Admin is one optional Agent Skill, with bundled scripts, for
managing installed copies of this pack. It can audit the source or a
directory you name, preview adoption, detect drift, and repair a copy after
backing it up, without deleting extra files in the destination.

## Try it

Run a read-only audit of the source from the repository root:

```sh
bun plugins/skillpack-admin/scripts/audit.mjs --root .
```

The result lists the discovered skills and reports validation or destination
state without writing files.

## How it works

```text
audit → choose a destination → preview → back up and apply → audit again
```

| Operation | Result | Writes? |
| --- | --- | --- |
| Audit | Source validation, or a `match`, `missing`, and `drift` inventory | No |
| Machine audit | Repository-local name collisions under one repositories root you name | No |
| Adopt | A preview or copy of the skills you select into a destination you name | Only with `--apply` |
| Sync | Adoption of every discovered skill | Only with `--apply` |
| Repair | Reviewed source files copied over the destination after a sibling backup | Only with `--repair --apply` |

## Interfaces

Use the `$skillpack-admin` skill for guided operation, or run the bundled
`audit.mjs`, `machine-audit.mjs`, `adopt.mjs`, and `sync.mjs` scripts
directly with explicit paths. The scripts require Bun 1.3 or a Node.js
24-compatible runtime.

## Checks

- Adoption previews by default.
- Repair refuses symbolic links and paths that leave the destination.
- Repair makes a complete sibling backup before copying reviewed source files
  over known files.
- Offline canary tests cover read-only preview, adoption, drift handling,
  backup, keeping extra files, and refusing symbolic links.

## Limits

- The tool manages installed copies of this pack and nothing else.
- It does not guess a personal skills directory. Name the source and the
  destination.
- It does not edit marketplace configuration, install network dependencies,
  fetch upstream sources, delete your skills, or take on product coding work.
- A `drift` result is a variant to review, not permission to overwrite it.

## Questions

### Is audit safe to run first?

Yes. Audit and machine audit only read. Note the paths and results before you
consider adoption or repair.

### Does repair remove files that are not in the pack?

No. It backs up the destination, copies reviewed source files over it, and
leaves extra files for you to decide about.

### Does this plugin manage a Hraness app or account?

No. Hraness publishes the pack, and this plugin manages only the pack’s
installed copies.

## Start

Read [`skills/skillpack-admin/SKILL.md`](skills/skillpack-admin/SKILL.md), run a
read-only audit, and install the optional plugin only if you manage copies of
this pack. Host-specific installation paths are in the
[`Hraness Agent Skills` README](../../README.md#install-in-the-host-you-already-use).

## Optional development support

After useful work, the guided skill may offer an optional Hraness membership.
The `bun scripts/support.mjs protocol --json` helper describes the local
cadence and the decline and acknowledgement controls. The audit, adoption, and
repair commands stay the same and never print promotional text.
