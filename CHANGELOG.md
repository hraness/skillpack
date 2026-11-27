# Changelog

## local-efficiency 0.11.0 - 2026-11-27

- The `session-transcripts` skill is removed. The owner retired session
  transcript sync; nothing in the pack syncs, pushes or deletes agent
  session transcripts any more. Transcripts already pushed to `transcripts`
  branches and local transcript files are left as they are.
- `disk-reclaim` no longer mentions transcript sync. The legacy `oh reclaim`
  pass is always run with `--no-transcripts`, and `oh transcripts` is not
  run.

## local-efficiency 0.10.0 - 2026-11-27

- Two new skills move here from the retired Diocles repository:
  `disk-reclaim` and `session-transcripts`.
- `disk-reclaim` starts from `oh-router reclaim`, which covers worktree build
  output, package caches and finished worktrees on its own 15-minute timer.
  The legacy `oh reclaim` pass is still documented for the targets the Router
  does not cover yet: Trash, Claude jobs and scratchpads, `.local/tmp`,
  temp-dir runtime caches, uninstalled app caches, Time Machine snapshots and
  transcript sync. The old `report-reclaim` loop and `oh reclaim setup` are
  retired.
- `session-transcripts` keeps the same sanitizing, orphan-branch layout and
  reclaim rules. It says that the fallback for unmapped sessions is still
  `hraness/diocles`, and that once that repository is archived those sessions
  are kept locally instead of pushed or reclaimed.

## local-efficiency 0.9.4 - 2026-11-27

- The skill has a new section, "Offloading whole tasks". It says when to
  send an independent task to another device with
  `oh-router spawn --device auto --headless --cwd REPO "BRIEF"`, how to
  follow it with `oh-router ps` and `oh-router inspect`, that its result
  comes back as a pushed branch or PR, and which work stays here. Guidance
  only; host-run is unchanged.

## local-efficiency 0.9.3 - 2026-11-27

- Forwarded runs no longer fail with "could not apply the commit bundle:
  some prerequisite commits exist in the object store, but are not connected
  to the repository's history". That happened when the remote clone was a
  partial (blob-less) clone and no ref there reached the commits the run
  built on, as with a pull request fetched into `FETCH_HEAD` for a detached
  worktree. mac-ui runs exited 69; compute runs rebuilt their cached
  workspace, losing its build output, and then ran on this Mac.
- host-run now sends a Git pack of the new commits instead of a
  `git bundle`, with the list of commits they build on. The remote checks
  that it has each of those and stops with exit 69 naming any it lacks. A
  full clone gets a thin pack, as with a bundle, so a one-line edit to a
  large file still travels as a small delta.
- A partial remote clone gets a self-contained pack instead: a changed file
  travels whole rather than as a delta against an old version that clone may
  never have fetched. Until now, such a run could stop with "pack has 1
  unresolved delta".
- When this clone has a reachability bitmap, a file the new commits share
  with a commit the remote has, but not with the commits they build on, is
  no longer left out of what host-run sends. A fix cherry-picked from main
  onto an older branch is one such file. A partial remote clone lacked it:
  mac-ui runs exited 69 with "checking out ... left 1 tracked files out",
  and compute runs rebuilt their workspace and then ran on this Mac.
- The remote side accepts only full commit names (40 hex digits, or 64 for
  SHA-256) for the commit to run and the commits it builds on. A shorter
  prefix used to pass.

## local-efficiency 0.9.2 - 2026-11-26

- A source comment in `host-run.ts` still said that a workstation's mac-ui
  lane never runs locally. Since 0.9.0, with a `presence` entry, it runs
  there only while the owner is idle at an unlocked screen. The comment now
  says so. Behaviour is unchanged.

## local-efficiency 0.9.1 - 2026-11-26

- Forwarding to a Mac whose clone is a partial (blob-less) clone works
  without credentials there: this Mac sends the file contents that clone
  lacks, once, with their count and size, into host-run's own object store
  on that Mac. The clone itself is never written.
- A forwarded checkout that leaves files out now stops with that reason
  instead of a later "could not apply the uncommitted changes" error.

## local-efficiency 0.9.0 - 2026-11-25

- With a `presence` entry in `~/.config/host-run/remote.json`, a
  workstation checks whether its owner is using it before each UI or heavy
  build run, and prints where the run goes and why.
- UI tests run here only while the owner is idle at an unlocked screen. If
  they start typing, play video, join a call or lock the screen, the run
  stops here and reruns on the other Mac. While they are busy and the other
  Mac is unreachable, the run waits instead of taking focus.
- Heavy builds stay here while the owner is idle or away and this Mac has
  room, and go to the other Mac otherwise. A build already running here
  drops to background priority while the owner is busy and returns to
  normal afterwards.
- `host-run presence` prints the check as JSON. `--remote` sends a run to
  the other Mac or fails; `--local` now also applies to UI runs. No signal
  needs a privacy prompt or grant.

## local-efficiency 0.8.0 - 2026-11-25

- A workstation can send heavy and exclusive compute runs to another Mac by
  adding a `compute` entry to `~/.config/host-run/remote.json`. The remote
  keeps a cached worktree per repository, reset to your commit and
  uncommitted changes on each run, so later builds are incremental. Runs
  there go through its own host-run and CI machine lock, at a lower priority.
- If the run cannot start there (host down, not a Git repository, changed
  submodules), it runs here and says why. A failure on the remote is final
  and is not rerun here. `--local` keeps a heavy run on this Mac.
- Only build settings such as `CARGO_*` and `RUSTFLAGS` travel with the
  run; tokens, secrets and local paths stay here.
- When the remote has no clone of the repository, forwarding (both
  `mac-ui` and compute) sends a one-time copy into host-run's own state
  there, never into `~/src`, capped at 2 GiB by default.

## local-efficiency 0.7.0 - 2026-11-25

- `host-run mac-ui install-helper` builds a small `HostRun UI.app` on the Mac
  that receives forwarded UI runs. Those runs then start through it, so you
  grant Accessibility, Screen Recording and Input Monitoring to that one app
  instead of to every shell. It only rebuilds when its own source changes,
  so grants survive host-run updates.
- The app runs only the job host-run staged for that run and refuses any
  other command. If it is configured but missing or broken, the run exits 69
  rather than starting without it.
- `host-run mac-ui probe` prints which privacy permissions a run has; run it
  through forwarding to see what forwarded runs get.

## local-efficiency 0.6.1 - 2026-11-25

- A Mac that runs CI benchmarks can name its CI machine lock in
  `~/.config/host-run/machine-lock.json`. Every `mac-ui` run there, forwarded
  or local, then holds that lock shared for the whole command, so UI tests
  never overlap a timed measurement. The wait comes before the UI slot is
  claimed, and a timeout runs nothing and exits 76.

## local-efficiency 0.6.0 - 2026-11-25

- Add a one-slot `mac-ui` host-run lane for Mac work that drives or shows UI:
  UI tests, native journeys that open windows, computer use or AppleScript
  against our own apps, and Simulator.app in front.
- On a Mac with `~/.config/host-run/remote.json`, send `mac-ui` runs to the
  configured Mac over ssh. The commit and uncommitted changes go along, the
  command runs in that Mac's desktop session in a throwaway checkout, output
  and the exit code come back, and `--artifacts=PATH` copies results home.
  Ctrl-C stops the remote run. Without the file the lane runs locally.
- Forwarding fails closed with exit 69 when the other Mac or its clone is
  unavailable. UI work never falls back to the local Mac.

## 0.2.2 - 2026-09-16

- Add optional general Hraness development support to original distribution
  guidance and the skillpack-admin closeout, with a self-contained shared helper.
- Preserve all adapted skill instructions and read-only audit behavior.

## 0.2.1 - 2026-09-01

- Reframe the root and all four plugin READMEs around a concrete result, first
  proof, working model, interfaces, evidence, boundaries, questions, and a
  source-first action.
- Align package, skills.sh, Agent Plugin, Codex, Cursor, Copilot, and OpenAI
  listing descriptions around the same bounded product promises.
- Add focused checks for the 33-skill inventory, proof-led public navigation,
  and cross-host description boundaries.

## 0.2.0 - 2026-09-01

- Rename the distribution-management plugin and skill from the misleading
  `hra-skillpack` identity to `skillpack-admin`; Hraness is the publisher, and
  none of the capability packs requires or operates the HRA product.
- Add public discovery metadata for GitHub Agent Skills and skills.sh, a
  directly addable GitHub Copilot CLI marketplace, and reviewed-submission
  packets for the OpenAI Plugins Directory and Cursor Marketplace.
- Add public support, privacy, and terms pages plus branded plugin assets.
- Publish all 33 canonical skills with explicit license metadata while
  preserving Rob Cheung's semantic material under its attributed permission
  grant rather than claiming an open-source license.
- Limit the public Cursor marketplace to the three MIT-licensed plugins;
  `semantic-algos` remains available from the source catalog and other
  compatible channels pending an accepted permissive license.
- Prepare OpenAI directory packets for Repository Engineering and Phased
  Delivery while explicitly deferring `semantic-algos` until its permission
  covers third-party public-directory redistribution.
- Preserve the legacy `.hra-skillpack-backups` repair directory for v0.1
  compatibility.

## 0.1.0 - 2026-09-01

- Add the 11-skill MECE Hraness Engineering pack, adapting selected PStack
  verification and investigation ideas with attribution.
- Consolidate Code Orchestrator into two discoverable skills with hidden worker
  protocols and an explicit HRA scheduling boundary.
- Add 19 explicit-only Semantic Algos skills by Rob Cheung, used with
  permission, with `five-whys` folded into the depth-five `n-whys` preset.
- Add Codex, Cursor, and Agent Plugins manifests; Cursor uses explicit command
  adapters for semantic operators.
- Add pack and machine audits, preview-first adoption, backup-first repair,
  routing fixtures, provenance locks, offline canaries, and two-platform CI.
