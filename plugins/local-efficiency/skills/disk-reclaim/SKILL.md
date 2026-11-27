---
name: disk-reclaim
description: >-
  Reclaim disk space on Hraness development machines (HRANESS1, HRA2 and other
  OH Router nodes). Use when free disk space drops, when inspecting storage
  growth, or when previewing, running or tuning deterministic node cleanup with
  `oh-router reclaim`, plus the legacy `oh reclaim` pass for the targets the
  Router does not cover yet. Do not use for Git worktree removal by exact path
  (use local-efficiency's worktree-cleanup), or to delete backups, model
  weights, credentials, session transcripts or source.
---

# Node disk reclaim

Two tools reclaim regenerable disk space on a node. Prefer the Router; use the
legacy pass only for what the Router does not cover.

| Tool | Covers | Schedule |
| --- | --- | --- |
| `oh-router reclaim` (OH Router, `ohd`) | Build output in linked Git worktrees under the scan roots (`~/src` by default), stale package-cache entries, and finished linked worktrees | `ohd` runs it every 15 minutes; it applies only under disk pressure |
| `oh reclaim` (legacy OH CLI) | Trash, finished Claude background jobs, `.local/tmp` scratch, dead Claude session scratchpads, temp-dir runtime caches, caches of uninstalled apps, and Time Machine local snapshots | Manual only |

Read [reclaim targets and strict exclusions](references/targets-and-boundaries.md)
before adding a deletion target or approving a removal by hand. Never delete
active worktrees, primary checkout build directories, `.local` release staging
directories, session transcripts, backups, model weights, or credentials
without the owner's explicit approval for that exact path.

## Router reclaim (`oh-router reclaim`)

```sh
oh-router reclaim                  # preview: what a pass would delete and why the rest stays
oh-router --json reclaim           # the same preview as JSON
oh-router reclaim status           # settings and the last pass's receipt
oh-router reclaim settings         # show the automatic settings
oh-router reclaim --apply          # delete what the preview lists
```

- The preview deletes nothing. It can take a few minutes on a large `~/src`;
  run it in the background rather than under a short timeout.
- `ohd` already runs reclaim on its own timer, so `--apply` by hand is rarely
  needed. When reclaim is turned off, `--apply` also needs `--force`; do not
  pass `--force` unless the owner asked for that pass.
- Defaults: `mode = apply`, every 15 minutes, acting only when free space is
  below 120 GiB or 15% of the volume, worktree build output idle for 12 hours,
  package-cache entries idle for a day, at most 50 deletions, 100 GiB per pass
  and 400 GiB per day.
- Finished worktrees (nothing uncommitted, `HEAD` on a freshly fetched remote
  ref or already in the default branch, only regenerable output ignored, idle
  for a day) are removed with `git worktree remove` under disk pressure. Each
  removal records a restore command in `<state>/reclaim/worktrees.jsonl`.
- Change settings with `oh-router reclaim settings --mode <off|dry_run|apply>`
  or `--set <JSON>`. The daemon refuses values past its safety limits (scan
  roots outside `~/src`, `min_free_percent` over 30, `worktree_idle_hours`
  under 6, larger byte limits); `--force` writes them anyway and needs the
  owner's approval.

## Legacy pass (`oh reclaim`)

The `oh` CLI is the legacy OH command line built from the Diocles repository.
It stays installed and working for the targets above that the Router does not
cover, but it no longer receives updates. Run it by hand only:

```sh
oh reclaim --json --no-transcripts            # dry run: deletes nothing
oh reclaim --apply --no-transcripts           # disk targets only
oh reclaim --pressure-only --json  # build-cache check used under disk pressure (add --apply to run it)
```

- Always read the dry run first, and always pass `--no-transcripts`. Session
  transcript sync is retired: an `oh` release older than the retirement still
  pushes transcripts and deletes idle local copies without that flag, and
  newer releases accept it and do nothing. Never run `oh transcripts`.
- Each full `--apply` writes a receipt to `<stateDir>/reclaim/status.json`
  and appends to `<stateDir>/reclaim/reclaim.log`. A full pass that ends below
  the low-space alert threshold (10% of the volume, 1 to 60 GiB) or reports
  an operational error sends a macOS notification.
- Its worktree-artifact and package-cache targets overlap the Router's. When
  both are installed, let the Router own those and use `oh reclaim` for the
  rest.

The old scheduled `report-reclaim` loop (`oh reclaim setup`, `oh loop add
--recipe report-reclaim`) and the `computer.oh.reclaim-pressure` launchd timer
are retired with the Diocles coordination service. Do not register them again;
the Router's timer replaces them.

## Reading the result

- Router preview and receipts list every kept candidate with its reason
  (`denylisted`, `no-project-marker`, held open, too recent, over a limit).
  Treat a reason as the guard working, not as a problem to bypass.
- `oh reclaim` reports `estimatedBytes` (files targeted) and the measured
  `freeBeforeGib`, `freeAfterGib` and `freeChangeBytes`. APFS clones can still
  share blocks after a directory is removed, and other processes change the
  free-space delta.
- A `Kept N ... .local/tmp entry(ies) that contain git repositories` warning
  means clones, worktrees, mirrors or bundles are parked in a repo's
  `.local/tmp`. Check each with `git status` and `git log @{u}..`, then delete
  finished ones by hand.
- A `Skipped bunx cache reclaim while a bun or bunx process is running`
  warning means a long-running tool started through bunx (such as an MCP
  server) is holding the bunx cache. Stop it if the disk needs the space.
- `hra-disk-guard janitor --report` (local-efficiency) lists Chrome
  `code_sign_clone` copies and bun staging directories without deleting them.
- If usage grows while no tool finds eligible cleanup, inspect the largest
  directories with `du -sk`, report their sizes, and get exact-path approval
  before removing anything covered by the strict exclusions.
