---
name: session-transcripts
description: >-
  Deterministically map, sanitize, persist, and reclaim Claude Code and Codex
  session transcripts onto isolated orphan branches (`transcripts`) in private
  `hraness/*` repositories with `oh transcripts`. Use when syncing active or
  historical transcripts, auditing transcript storage, or reclaiming idle
  (over 14 days) local session data and Codex SQLite projections. Do not use
  for general disk cleanup (use disk-reclaim), for reading or summarizing a
  session's content, or to push transcripts to a public repository.
---

# Session transcript persistence and reclaim

`oh transcripts` persists Claude Code and Codex session transcripts into the
private `hraness/*` repositories they belong to, keeps long-running active
transcripts updated incrementally, and reclaims local storage once sessions
are idle. It ships in the legacy OH CLI (`oh`), which stays installed for this
and for the legacy reclaim pass; the OH Router has no transcript sync yet.

Read [mapping, sanitization, and branch layout](references/mapping-and-sanitization.md)
before changing routing rules, redaction patterns, or retention thresholds.

## Inspect and sync

1. Always preview routing and reclaim candidates first with a dry run:

   ```sh
   oh transcripts
   oh transcripts --json
   ```

   The dry run reads local transcript headers and Codex's `state_5.sqlite`
   index read-only, classifies every session (`hraness/<repo>`, the fallback
   repository, or `retired`), and reports exact sync and reclaim counts without
   writing Git objects, pushing, or deleting files. It can take several
   minutes; run it in the background.

2. Persist and reclaim idle local copies (pushes to GitHub, deletes local
   files that are verified on the remote):

   ```sh
   oh transcripts --apply
   ```

   To update the remote `transcripts` branches without deleting local files:

   ```sh
   oh transcripts --apply --no-reclaim
   ```

   `oh reclaim --apply` runs the same sync as part of the legacy disk pass.

## Fallback repository

Sessions that map to no single private repository (home-directory and
multi-repo sessions, sessions whose repository is public, a fork, or has no
local checkout) go to a fallback repository built into `oh transcripts`. That
fallback is still `hraness/diocles`, which is being retired. No other existing
private `hraness/*` repository is meant to hold these sessions, so the fallback
has not moved yet.

Until a new fallback ships, read the dry run's `hraness/diocles` row as the
fallback. Once `hraness/diocles` is archived, the private-repo check refuses
it: those sessions are reported as `Cannot persist`, nothing is pushed for
them, and their local files are kept rather than reclaimed. Do not work around
that by pushing them elsewhere by hand.

## Core invariants

- **Never touch `main` or working trees.** Commits are built through a
  temporary `GIT_INDEX_FILE` (`git hash-object -w`, `git update-index
  --cacheinfo`, `git write-tree`, `git commit-tree`) and pushed with
  `--force-with-lease` to `refs/heads/transcripts`. Active branches, staged
  changes, and CI workflows on `main` are untouched.
- **Private `hraness/*` repositories only.** Before any push, `gh repo view
  <owner/repo> --json isPrivate,isArchived,isFork` must show `isPrivate: true`,
  `isArchived: false`, and `isFork: false`. Sessions mapped to public
  repositories, forks, or missing checkouts route to the fallback. Retired
  projects are never pushed.
- **Sanitize before hashing.** Inline base64 images and screenshots, data URLs,
  opaque blobs over 32 KiB, and credential patterns (API keys, GitHub tokens,
  JWTs, Bearer tokens, private keys) are elided or redacted before `git
  hash-object`. Files over 45 MiB split deterministically into `.partNNN.jsonl`
  chunks.
- **Active sessions stay intact locally.** Sessions open in `cmux`, tracked as
  active by OH launchers, or modified within `--idle-days` (default `14`) are
  synced incrementally when their `(size, mtimeMs)` changes, while their local
  `.jsonl` files stay so `--continue` and `--resume` keep working.
- **Reclaim requires remote proof.** Local `.jsonl` transcripts and Claude
  `<sessionId>/` subagent directories are deleted only when idle past
  `--idle-days`, absent from active `cmux` sessions, and either recorded with a
  verified commit SHA on `origin/transcripts` in
  `<stateDir>/transcript-sync/ledger.json` or classified `retired`.
- **Safe SQLite compaction.** Codex's `thread_history_1.sqlite` projection
  cache is pruned in bounded `BEGIN IMMEDIATE` batches for threads no longer
  kept on disk, followed by `PRAGMA wal_checkpoint(TRUNCATE)` and an in-place
  `VACUUM` (never a `rename()` over an open WAL database; `SQLITE_BUSY` defers
  `VACUUM` cleanly).
- **Never read or copy provider auth files.** Scan only Claude
  `projects/*/*.jsonl` and Codex `sessions/`, `archived_sessions/`,
  `state_5.sqlite` and `thread_history_1.sqlite`. Leave OAuth tokens, Keychain
  items, cookies, and `auth.json` untouched.
