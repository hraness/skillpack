# Reclaim targets and strict exclusions

Both tools measure the macOS Data volume or the Linux home filesystem. Neither
deletes anything outside the targets listed here.

## Router targets (`oh-router reclaim`)

1. **Worktree build output.** A directory named exactly `node_modules`,
   `target`, `.next`, `.turbo`, `.venv` or `.build` at the root of a linked Git
   worktree (its `.git` is a file that Git's own records confirm) under the scan
   roots, next to the project file of the tool that writes it (`Cargo.toml` and
   a `target/CACHEDIR.TAG`, `package.json`, `.venv/pyvenv.cfg`,
   `Package.swift`). For Cargo and SwiftPM only debug output and compiler caches
   are eligible. A primary checkout is never touched, and `dist` is never a
   target.
2. **Package-cache entries.** Stale entries inside fixed cache roots: npm, bun,
   Cargo registry, Go build, Xcode DerivedData and device support, simulator
   caches, uv, pip, Homebrew downloads, Yarn, ccache, sccache and the pnpm
   store. The cache root itself is never removed.
3. **Finished worktrees.** Whole linked worktrees whose work is already on a
   remote, removed with `git worktree remove` and logged with a restore command
   (see the main skill).

Every guard runs again just before removal; the target is renamed to a hidden
`.oh-reclaim-*` sibling, checked once more, and removed by a walk that never
follows symlinks or crosses into another filesystem. Paths under the
denylist (keychains, cloud storage, mail and messages, simulator devices, Xcode
archives, `.local/share`, `.local/state`, `.config`, `.ssh`, `.gnupg`, cloud CLI
config, `.codex`, `.claude`, `.ollama`, Trash, Documents, Desktop, Downloads,
backups, model caches, Playwright browsers, Cargo binaries, Go modules) and any
path with a `.local`, `.claude`, `.codex`, `.plans`, `.git`, `backups` or
`application support` component are refused.

## Legacy-only targets (`oh reclaim --apply`)

The low-space alert threshold is 10% of capacity (1 to 60 GiB); the build-cache
threshold is 15% (1 to 120 GiB). Shorter cutoffs below apply only under those
thresholds.

1. **Trash (macOS):** `~/.Trash/*` when readable by the current process (a
   blocked read is a non-fatal warning).
2. **Claude background jobs (`~/.claude/jobs`):** job directories whose
   `state.json` is `done` or `stopped`, or `blocked` and untouched for 3 days.
   Never `pins.json`, a pinned job, or an active job.
3. **Gitignored scratch in `<repo>/.local/tmp`** (idle 7 days, 24 hours under
   the alert threshold): each direct child only when `.local/tmp` is a real,
   owned, Git-ignored directory with no tracked files; `lsof` shows nothing open
   inside; nothing changed past the cutoff by mtime or ctime (re-checked with
   `lstat` just before removal); and the child holds no Git storage (no `.git`,
   bare repository or `*.bundle`). Clones, worktrees, mirrors and bundles are
   kept and reported. Nothing else under `.local` is in scope.
4. **Dead Claude session scratchpads** (`/private/tmp/claude-<uid>` on macOS,
   `/tmp/claude-<uid>` on Linux): `<projectSlug>/<sessionUuid>` directories
   owned by the current user, untouched for 3 hours, not active or restorable
   in `cmux` or recent OH runs (fails closed when `cmux` cannot be queried),
   and not held open (fails closed when `lsof` fails). For live sessions only
   idle entries inside `scratchpad/` are pruned (24 hours, 6 under pressure).
   Shared top-level directories and symlinks are never touched.
5. **Temp-dir runtime caches (`$DARWIN_USER_TEMP_DIR`):** Chrome
   `code_sign_clone.*` copies idle 12 hours and not held open; bun staging
   directories idle 60 minutes while no bun install runs; `node-compile-cache`,
   `tsx-<digits>` and `bunx-<digits>-*` entries past their cutoff, never while a
   bun or bunx process runs, and never sockets or FIFOs.
6. **Caches of uninstalled macOS apps (`~/Library/Caches` only):** a fixed list
   of pure cache folders, checked against every known `.app` name in
   `/Applications` and `~/Applications` first. Never `Application Support`.
7. **Time Machine local snapshots (macOS):** unprivileged `tmutil
   thinlocalsnapshots` and `deletelocalsnapshots`; a warning when `sudo` is
   needed.
8. **Session transcripts and the Codex SQLite cache:** not a target. Transcript
   sync was retired on 2026-11-27; run `oh reclaim` with `--no-transcripts` and
   leave local transcripts and existing `transcripts` branches alone.

`oh reclaim` also prunes worktree build output and package caches with its own
guards (Git-ignored, no tracked files, nothing open, idle past 12 hours or 2
under pressure). Prefer the Router for those.

## Strict exclusions (never touch autonomously)

- Active source code, uncommitted edits, primary checkout build directories,
  everything under `.local` except `.local/tmp` (release staging, receipts,
  models, release symbols, benchmarks, research), and Git history in `~/src`
  and `~/Documents`.
- `~/Library/Application Support` state, `CoreSimulator/Devices`, and pinned
  Playwright or Chrome for Testing browsers (`ms-playwright`).
- Backups (`~/Backups`, product backup folders in the home directory and
  `~/.cache`, `MobileSync`).
- Downloaded model weights (`~/.local/share/llm-models`, `~/.cache/huggingface`
  and other model caches, `FluidAudio`).
- Provider credentials, OAuth tokens, Keychain state, OH profile bindings and
  journals, and active `cmux` terminals.
- `~/Documents/Codex` workspaces, `~/Documents/videos`, and caches of installed
  apps.
- Git clones, linked worktrees, nested repositories, bare mirrors and
  `*.bundle` files inside `.local/tmp`, however old. They are reported, never
  removed.
- Large stale data that no tool can prove is scratch (release staging,
  benchmark videos, render outputs, device recovery folders). Report it with
  sizes; never delete it autonomously.
