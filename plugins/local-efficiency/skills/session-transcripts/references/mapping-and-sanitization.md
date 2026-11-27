# Mapping, sanitization, and branch layout

## Sources scanned per node

- **Claude global:** `~/.claude/projects/<project-slug>/<sessionId>.jsonl` (and
  the sibling `<sessionId>/` directory during reclaim).
- **OH-managed Claude profiles:**
  `<stateDir>/claude-profiles/<accountKey>/config/projects/<project-slug>/<sessionId>.jsonl`
  (synthetic continuation and `*-fixture-*` directories are skipped).
- **Codex global:** `sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl` in
  the Codex home (`$CODEX_HOME`), enriched read-only from its `state_5.sqlite`
  `threads` table.
- **OH-managed Codex profiles:** `sessions/**/*.jsonl` and
  `archived_sessions/**/*.jsonl` in each profile's Codex home
  (`<stateDir>/codex-profiles/<profileKey>/home`), enriched from
  `<profile>/sqlite/state_5.sqlite`.

## Deterministic repository resolution order

1. **Git origin:** Codex `threads.git_origin_url` or
   `session_meta.payload.git`, parsed to `owner/repo`.
2. **Checkout prefix:** the working directory matched against the local
   checkouts in the OH config's projects and `~/src/*` (longest path prefix
   wins). Both fetch and push `origin` URLs must name the same repository.
3. **Worktree and directory naming rules:** a fixed table maps worktree and
   directory name prefixes under `~/src` (even for worktrees already pruned
   from disk) to their active private `hraness/*` repository.
4. **Generic launch directories (`~` or `~/Documents`):** reads up to the first
   350 JSONL records and uses, in order, a dominant non-home `cwd` (at least
   70% of non-home observations), a Claude `custom-title` matching a stored
   project key, a dominant `~/src/<dir>` or `~/Documents/<dir>` path reference
   (at least 70% with at least 3 hits), and the Claude project slug.
5. **Fallback:** multi-repo and general home-directory sessions route to the
   fallback repository (see the main skill), as do sessions whose target is
   public, a fork, or has no local checkout.
6. **Retired filter:** a token matching a retired project name classifies the
   session as `retired`; it is never pushed and is reclaimed locally once idle.

## Orphan branch tree layout

On `refs/heads/transcripts` of each target private repository:

```text
nodes/
  <node-slug>/
    manifest.json
    claude/
      YYYY-MM/
        <sessionId>.jsonl
        profile_<hash8>-<sessionId>.jsonl
    codex/
      YYYY-MM/
        rollout-<timestamp>-<threadId>.jsonl
```

Partitioning under `nodes/<node-slug>/` keeps nodes from writing overlapping
paths. If two nodes push at once, the batch push fetches the new tip and
replays its tree update with `--force-with-lease`.
