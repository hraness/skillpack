---
name: disk-reclaim
description: >-
  Reclaim disk space on Hraness development machines (HRANESS1, HRA2 and other
  OH Router nodes). Use when free disk space drops, when inspecting storage
  growth, or when previewing, running or tuning deterministic node cleanup with
  `oh-router reclaim`, and for measuring the places it does not clean
  (Trash, scratchpads, Time Machine snapshots). Do not use for Git worktree removal by exact path
  (use local-efficiency's worktree-cleanup), or to delete backups, model
  weights, credentials, session transcripts or source.
---

# Node disk reclaim

The OH Router is the only tool that deletes anything on a node by itself.

| What | Covers | Schedule |
| --- | --- | --- |
| `oh-router reclaim` (OH Router, `ohd`) | Build output in linked Git worktrees under the scan roots (`~/src` by default), stale package-cache entries, and finished linked worktrees | `ohd` runs it every 15 minutes; it applies only under disk pressure |
| Places the Router does not clean | Trash, finished Claude background jobs, `.local/tmp` scratch, dead Claude session scratchpads, temp-dir runtime caches, caches of uninstalled apps, and Time Machine local snapshots | Not automated: measure and report; remove by hand only after the owner agrees |

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

## Places the Router does not clean

The legacy `oh` CLI and its `oh reclaim` pass are retired; do not run `oh`
for cleanup. Nothing cleans the places below automatically. Measure them
without deleting anything and report the sizes:

```sh
du -sh ~/.Trash ~/.claude/jobs /private/tmp/claude-$(id -u) "$(getconf DARWIN_USER_TEMP_DIR)" 2>/dev/null
du -sh ~/src/*/.local/tmp 2>/dev/null
tmutil listlocalsnapshots /
```

Remove something here only by hand, for the exact paths the owner agreed to,
and only within the rules in
[reclaim targets and strict exclusions](references/targets-and-boundaries.md).
Never empty the Trash, delete a live session's scratchpad, or remove a Git
clone, worktree or bundle parked in `.local/tmp` without that approval.

The old scheduled `report-reclaim` loop and the `computer.oh.reclaim-pressure`
launchd timer are retired. Do not register them again; the Router's timer
replaces them.

## Reading the result

- Router preview and receipts list every kept candidate with its reason
  (`denylisted`, `no-project-marker`, held open, too recent, over a limit).
  Treat a reason as the guard working, not as a problem to bypass.
- Measure free space with `df -h` before and after. APFS clones can still
  share blocks after a directory is removed, and other processes change the
  free-space delta.
- Clones, worktrees, mirrors or bundles parked in a repo's `.local/tmp`: check
  each with `git status` and `git log @{u}..`, then report the finished ones
  for the owner to approve.
- `hra-disk-guard janitor --report` (local-efficiency) lists Chrome
  `code_sign_clone` copies and bun staging directories without deleting them.
- If usage grows while no tool finds eligible cleanup, inspect the largest
  directories with `du -sk`, report their sizes, and get exact-path approval
  before removing anything covered by the strict exclusions.
