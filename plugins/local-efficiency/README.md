# Local Efficiency

Local Efficiency is one optional Agent Skill with bundled Bun scripts for
Hraness development machines. It installs and audits a managed baseline for
Codex and Claude: approval and autonomy guidance, local capability-lane
scheduling, validation receipts, throughput telemetry, worktree and dev-server
cleanup, disk guarding, deterministic dev ports, and controlled signed-in
browser recovery.

It manages machine-local configuration only. It adds no cloud execution, no
provider credentials, and no repository bypass.

## Commands

Bootstrap links these into the configured Bun `bin` directory:

| Command | Purpose |
| --- | --- |
| `host-run` | Capability-lane scheduler: compute, browser, browser-auth, mac-native |
| `validation-run` | Bounded validation wrapper with receipts |
| `workspace-audit` | Read-only inventory of repositories and checkouts |
| `session-audit` | Agent session and approval-surface inventory |
| `throughput-report` | Local throughput telemetry summary |
| `ci-ref-audit` | Complete-history CI ref isolation and drift audit |
| `repo-adoption` | Preview or apply repository guidance adoption |
| `local-efficiency` | Doctor: verify baseline, commands, and managed blocks |
| `worktree-cleanup` | Reclaim verified clean merged worktrees by exact path |
| `dev-server-reap` | Audit stale dev servers and orphaned browser sessions |
| `hra-port` | Deterministic per-project port assignment |
| `hra-disk-guard` | Local disk-pressure audit and bounded cleanup targets |
| `hra-chrome` | Provisioned Chrome for Testing launcher for agent runs |
| `hra-chrome-restart` | Graceful restart of the signed-in Chrome via `open -a` |

## Try it

Preview the baseline without writing:

```sh
bun plugins/local-efficiency/skills/local-efficiency/scripts/bootstrap.ts --check
```

Then install with `bootstrap.ts --apply`, or use the `$local-efficiency`
skill for guided operation.

## Checks

- Audits are read-only by default; mutations preview first and refuse unsafe
  targets.
- Global config edits are marker-bounded and idempotent; unrelated user
  configuration is preserved byte-for-byte.
- Browser recovery terminates the signed-in Chrome with TERM, waits for a
  clean exit, relaunches through LaunchServices, and verifies the new
  executable record. It never force-kills or cold-launches.
- Tests use temporary fixtures and never touch real global state.

## Limits

- macOS-first: process, LaunchServices, and launchd behaviour assumes Darwin.
- The scheduler coordinates one machine; it is not a CI or remote runner.
- `hra-chrome-restart` touches the user's signed-in browser only under
  explicit authorization and the `browser-auth` lane.
