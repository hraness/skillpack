# Provenance

`local-efficiency` is original Hraness material. It was developed for Hraness
development machines inside the retired `hra` repository (later renamed
`oompa`, now archived), where it was distributed as `oompa-local-efficiency`.
Its installed copies continued to evolve locally; this port carries the
current installed state, including the `hra-*` command names, unchanged in
behaviour except where noted below.

Port adjustments for this pack:

- Manifests added in Agent Plugin, Codex, and Cursor formats.
- Fixture paths rewritten to neutral temporary paths to satisfy the
  repository's no-private-paths policy.
- The disk-guard scratchpad default now resolves `claude-<uid>` from
  `process.getuid()` instead of hard-coding uid 501.
- `hra-chrome-restart` (signed-in Chrome recovery) was added after the
  archive; this is its first published home.
