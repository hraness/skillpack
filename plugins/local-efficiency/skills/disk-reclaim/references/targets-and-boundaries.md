# Reclaim targets and strict exclusions

The Router measures the macOS Data volume or the Linux home filesystem and
deletes nothing outside its targets listed here.

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

## Places the Router does not clean (by hand only)

These were the legacy `oh reclaim` targets. That pass is retired and nothing
cleans them automatically. Measure and report them; remove only the exact
paths the owner approves, keeping each guard below.

1. **Trash (macOS):** `~/.Trash/*`.
2. **Claude background jobs (`~/.claude/jobs`):** job directories whose
   `state.json` is `done` or `stopped`, or `blocked` and untouched for 3 days.
   Never `pins.json`, a pinned job, or an active job.
3. **Gitignored scratch in `<repo>/.local/tmp`:** a direct child only when
   `.local/tmp` is Git-ignored with no tracked files, `lsof` shows nothing open
   inside, it has been idle for days, and it holds no Git storage (no `.git`,
   bare repository or `*.bundle`). Nothing else under `.local` is in scope.
4. **Dead Claude session scratchpads** (`/private/tmp/claude-<uid>` on macOS,
   `/tmp/claude-<uid>` on Linux): `<projectSlug>/<sessionUuid>` directories of
   sessions that are no longer running and not held open. Never a live
   session's scratchpad, a shared top-level directory or a symlink.
5. **Temp-dir runtime caches (`$DARWIN_USER_TEMP_DIR`):** Chrome
   `code_sign_clone.*` copies, bun staging directories, `node-compile-cache`,
   `tsx-<digits>` and `bunx-<digits>-*` entries, never while they are held open
   or a bun or bunx process runs. `hra-disk-guard janitor --report` lists them.
6. **Caches of uninstalled macOS apps (`~/Library/Caches` only):** pure cache
   folders of apps no longer in `/Applications` or `~/Applications`. Never
   `Application Support`.
7. **Time Machine local snapshots (macOS):** list with `tmutil
   listlocalsnapshots /`; thinning or deleting them is the owner's call.
8. **Session transcripts and the Codex SQLite cache:** never a target. Leave
   local transcripts and existing `transcripts` branches alone.

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
