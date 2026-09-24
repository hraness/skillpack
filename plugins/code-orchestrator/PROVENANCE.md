# Provenance

The Code Orchestrator plugin adapts Rob Cheung's `code-orchestrator` material,
copyright 2026 Rob Cheung, under the MIT License in [LICENSE](LICENSE).

Pinned upstream:

- Repository: `https://github.com/kousun12/code-orchestrator`
- Revision: `989e49ba7b0d8cb922010272abe6748dd68a4adb`
- Adapted paths: `skills/write-phase-plan`, `skills/phase-orchestrator`,
  `skills/phase-implementer`, `skills/phase-reviewer`, and
  `skills/phase-final-reviewer`

The portable Hraness adaptation also incorporates the current Jungle workflow
at the locally available `origin/main` revision
`4904c3dc9dbf41845fa2d5e4dfc02af90bb131c4`. Hraness changes consolidate the
three worker skills into hidden references, preserve repository-owned delivery
gates, and explicitly defer heavyweight scheduling to the installed local
efficiency policy.

The exact source records are machine-readable in [sources.lock.json](sources.lock.json).
