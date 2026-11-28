---
name: local-efficiency
description: >-
  Install, audit, and operate the Hraness local Codex and Claude Code efficiency
  and approval-autonomy baseline across repositories and Macs. Use for managed
  agent permission defaults, repository delivery guidance, Codex swarm throughput, host-wide
  heavyweight-command scheduling, capability lanes, privacy-safe telemetry,
  validation ownership and exact-tree receipts, stale-task reporting, guarded
  Git worktree cleanup, complete-history CI ref isolation, model-lane setup, or
  checking whether a Hraness machine follows the standard. Preserve useful
  agent fan-out and all repository final gates. Do not use for cloud execution
  or cloud optimization.
---

# Local efficiency

Keep parallel reasoning and routine authorized delivery moving without human
prompt churn. Reduce duplicated validation, conflicting local compute,
unnecessary checkouts, stale state, and verified disposable disk use while
preserving sandbox, provider, repository, and release gates.

## Choose the mode

- **Install or update this Mac:** run `bun run scripts/bootstrap.ts --apply`
  from this skill directory, then run it again with `--check`. This manages
  Codex automatic approval review and workspace permissions plus Claude Code
  Auto mode and global guidance; it never enables a bypass-permissions mode.
- **Inspect this Mac:** run `local-efficiency --json` (or
  `bun run scripts/doctor.ts --json`) to check the managed global Codex and
  Claude settings, then run `bun run scripts/workspace-audit.ts` and
  `bun run scripts/session-audit.ts`. All three are read-only. Add
  `--sizes` only when the slower recursive worktree-size estimate is useful.
  The workspace audit reports each Hraness repository's managed guidance
  status; use `repo-adoption.ts --apply --root ABSOLUTE-REPO` for each reported
  `needs-update` repository.
- **Measure local throughput:** run `throughput-report` for the bounded,
  privacy-safe scheduler history. Treat repeat command digests and silent tasks
  as review heuristics, never as proof of waste or abandonment.
- **Run heavyweight local work:** resolve `host-run` to its installed
  absolute path and use `ABSOLUTE-HOST-RUN
  --mode=shared|heavy|exclusive
  --lane=compute|browser|browser-auth|mac-native|mac-ui --label=LABEL
  [--max-hold=DURATION|none] [--full-cpu] [--local|--remote] [--artifacts=PATH ...] -- COMMAND ...` through
  reviewed host access. Keep the complete wrapper and child argv visible to
  Codex. Use `ABSOLUTE-HOST-RUN --status [--json]` for a read-only live holder
  and permit census without acquiring a lease, and `ABSOLUTE-HOST-RUN presence`
  to see whether this Mac's owner is using it.
- **Record or reuse deterministic focused validation:** use `validation-run`.
  Reuse is opt-in and is never valid for a required final integration,
  merge-queue, deployment, release, authenticated-browser, or network-sensitive
  gate.
- **Reclaim Git worktrees:** audit first with `workspace-audit.ts`, then invoke
  `worktree-cleanup.ts` separately in each owning repository with every approved
  absolute path named through `--remove`.
- **Adopt or check repository guidance:** use `repo-adoption.ts --check` or
  `--apply`. It edits only the exact managed policy block in root `AGENTS.md`
  and adds an `@AGENTS.md` import to root `CLAUDE.md` while preserving existing
  Claude-specific guidance.
- **Audit CI ref isolation:** use `ci-ref-audit --root ABSOLUTE-REPO`. Review
  every candidate; fix only workflows whose complete-history gate can import
  unrelated refs, and preserve the complete-history scan itself.

Run scripts from the installed skill directory when the convenience commands
are unavailable. `bootstrap.ts` installs or refreshes those commands under the
user's Bun bin directory, mirroring the plugin into the user's local data
directory when invoked from a versioned plugin cache so cache pruning cannot
leave dangling links. It verifies a minimal pinned Atet host-resource
runtime in the user's local data directory; it never replaces a global Atet
package or command.

## Preserve the invariants

- Treat a user request that places a repository and outcome in scope as
  standing authorization for routine task-owned commits, pushes, pull requests,
  merges, releases, and deployments after required gates pass. Do not ask for a
  second conversational confirmation. Runtime denials, missing credentials, and
  material product decisions still stop the work.
- Prefer short-lived repository workload identities, npm trusted publishing,
  and scoped GitHub App tokens over personal sessions and reusable secrets.
  Batch unavoidable interactive authentication at the final boundary rather
  than spreading it across retries or releases.

- Do not cap agent count merely to reduce fan-out. Parallel reasoning and
  independent implementation lanes remain desirable.
- Prefer bounded subagents in the current task for research, review, diagnosis,
  and focused checks when they can safely share one working tree. A separate
  task or worktree is warranted for independently deliverable divergent edits,
  an intentionally isolated verification tree, or a different environment.
- Give each focused check one worker owner. The integrator reviews the diff and
  reported evidence, repeating a focused command only when the tree changed,
  evidence is missing, or a repair invalidated it.
- Give each CI run, merge-queue item, provider operation, or deployment wait one
  waiter. Do not hold a compute lease while waiting on external state.
- Run the repository's aggregate/final gate once after convergence. Never use a
  receipt to skip a repository-required final replayed-tree or delivery gate.
- When the host scheduler is saturated or a heavyweight gate would queue behind
  unrelated work, prefer the repository's required CI check as the broad
  aggregate: finish focused local validation, open the pull request, and let
  `Required` run the broad suite on the PR head instead of holding a shared
  lease. Keep narrow tests, typecheck, and lint local in the edit loop; keep
  authenticated-browser, fixed-port, native-device, credential, and
  private-data work on the documented local lanes; and honor any repository
  rule that requires a local gate before pushing.
- After a scheduled check fails, rerun only the failing test, file, or package
  until it passes, then run the broad check once. Rerunning a full suite for
  each fix sends the same long job back through the queue every time.
- The host scheduler is an outer layer. Jungle and other repositories keep their own
  schedulers underneath it; invoke `host-run` only around top-level
  commands. Nested `host-run` calls inherit the outer lease and do not
  acquire again.
- Keep roots and integrators on the caller's selected model. Bounded independent
  workers may use the installed `worker` or `routine` profiles when the
  task merits them; measure repair rate rather than assuming cheaper is better.
- This baseline is local-only. Do not create, configure, or route work to Codex
  cloud through this skill.

## Capability lanes

- **Ordinary:** research, review, edits, and narrow checks. Share the current
  task worktree when safe and normally do not acquire a host lease.
- **Heavy compute:** broad builds and repository gates. Use the `compute` lane
  with `heavy` or `exclusive` mode.
- **Browser (headless):** agent-browser, Playwright, or Chromium checks with a
  fresh temporary profile. Use the `browser` lane (4 slots). Default max hold
  20 min.
- **Browser auth:** only work that drives the user's signed-in browser profile
  or a headed interactive login. Use the `browser-auth` lane (1 slot) and keep
  one owner. Default max hold 45 min.
- **Never in a browser lane:** static file servers, `next dev`/preview servers,
  and merge-queue, CI, or deploy drain loops. Start a server on
  `${PORT:-$(hra-port NAME)}` bound to 127.0.0.1 with a trap that stops it when
  the command ends, and wrap only each local validation step of a drain loop,
  never the wait. `dev-server-reap` reports servers left behind.
- **Orphaned test runners:** `orphan-runner-sweep` lists node and bun test
  runners (`node --test`, `*.test.*` files, `bun test`, vitest, jest) that
  outlived their task: reparented to PID 1, older than 2 h (`--min-age`), and
  outside any live host-run lease or agent process tree. It changes nothing
  by default. `--apply` rechecks each process's start time and command, sends
  SIGTERM only, waits (`--grace`, default 10 s), and lists any that kept
  running. It never sends SIGKILL; check survivors yourself before stopping
  them.
- **Chrome:** never launch the installed, auto-updating Google Chrome from a
  shell or test. Use Chrome for Testing or the project's pinned Playwright
  Chromium with a temporary profile. Agent-browser inside host-run launches
  through `hra-chrome`, which retains explicit executable selection and reads
  `executablePath` from `./agent-browser.json` over `~/.agent-browser/config.json`
  when no executable override exists. For direct launches, use
  `$HRA_CHROME`/`hra-chrome` with `HRA_CHROME_REAL` set to the provisioned binary;
  `AGENT_BROWSER_CONFIG` can select a specific config file. Missing or unsafe
  executables fail with provisioning guidance; there is no system-Chrome
  fallback or guessed cache version. The launcher merges
  `PaintHolding,MacAppCodeSignClone` into one `--disable-features` switch and
  always adds `--mute-audio` to prevent bundle clones and stray audio. Close
  owned browsers and pass a timeout to one-shot `--screenshot` runs. Attaching
  to the user's signed-in Chrome remains a separate authorized browser-auth
  flow that preserves its profile and lifetime. When the signed-in Chrome is
  itself the blocker — a stale in-place-updated process whose executable no
  longer resolves to the kernel, wedged audio, or a hung window —
  `hra-chrome-restart` SIGTERMs the main process so the session saves, waits
  for a clean exit, relaunches through `open -a` under LaunchServices (never
  an agent-owned child), and verifies the new process's executable record
  resolves. It refuses when Chrome is not running and never force-kills; a
  Chrome that ignores TERM is reported, not SIGKILLed. Run it inside the
  `browser-auth` lane.
- **Mac native:** Xcode, Simulator, Keychain, signed-app, or other macOS-only
  work. Keep it on a Mac and use the `mac-native` lane. The lane has two
  slots: two `shared` or `heavy` native jobs (Swift builds, unit tests,
  headless simulator tests) run side by side, and `exclusive` takes both slots. Use
  `exclusive` only for work that cannot overlap another native job, such as
  signing or packaging that touches the Keychain or a fixed device. Work that
  shows or drives UI goes in `mac-ui` instead.
- **Mac UI:** native work that drives or shows UI: XCUITest and other macOS
  or iOS UI tests, native `ra walk` journeys that open windows, computer use
  or AppleScript against our own apps, and anything that launches an app
  window or brings Simulator.app to the front. Use `--lane=mac-ui`. The lane
  has one slot, so UI runs never fight over focus, and a 60 min default max
  hold. A `mac-ui` owner may run nested `mac-native` and compute steps, such
  as the build its UI tests need. On a workstation it is forwarded to another
  Mac, or runs here only while the owner is away from the keyboard; see below.

The browser, browser-auth, mac-native and mac-ui lanes bound their scarce capability while
still sharing the weighted compute capacity; on those lanes `exclusive` means
exclusive use of the capability and takes at most 2 CPU permits by default.
For macOS-only work that needs all CPU capacity, opt in with
`--mode=exclusive --lane=mac-native --full-cpu`. The bare `--full-cpu` flag is
valid only with that mode and lane; it reserves every CPU permit and
both Mac-native slots before starting the command. Other modes and lanes reject it.
A nested wrapper must be covered by the outer lane (a `browser-auth` owner may
also run `browser` work) and CPU reservation. A two-permit native owner cannot
escalate to full CPU on a machine with more than two permits; a full-capacity
native owner covers ordinary or full-CPU native work and compute work. Choose
the top-level reservation correctly instead of escalating inside a lease.

Every admitted lease has a wall-clock cap: exclusive 60 min, browser 20 min,
browser-auth 45 min, mac-ui 60 min (the smallest applicable wins; compute
shared/heavy have none). host-run warns at 80%, then sends TERM and finally KILL to the leased
command only, and records outcome `hold-timeout` (exit 124). Pass
`--max-hold=90m` (or `none`) with a reason when a run genuinely needs longer.
A queued claim gives up after 2 h (exit 75, `QUEUE_TIMEOUT`); while it waits,
host-run prints each holder's label, pid, and age every minute.

CPU capacity is weighted permits: 6 on hosts with 16 or more cores, 4 on 12–15,
3 on 6–11, 2 on 3–5, 1 below that.

A permit stands for cores / capacity cores, but a holder can sit nearly idle
for hours (a soak, an emulator, a dev loop). So when every permit is held, a
`shared` or `heavy` run that has waited 5 seconds may borrow permits from a
second pool of the same size. host-run measures the host every 15 seconds
and lends only while it has room: the cores the run would use, plus 20% of
all cores, were idle since the last measurement, and at least 25% of memory
is free. A loan admitted in
the last 90 seconds counts at its full share until the measurement includes
it. The run keeps its place in the ordinary queue until a loan admits it, and
the admission message says `on borrowed permits`. An `exclusive` run never
borrows; a run that takes every CPU permit also takes every borrowed permit
before it starts, so it still runs alone, and no new loan starts while it
waits, so later runs cannot overtake it. `--status` shows `borrowed=N` and
marks each borrowing holder `pool=overflow`; telemetry records
`pool: "overflow"`. Set `LOCAL_EFFICIENCY_LENDING=off` to wait for ordinary
permits only.

Inside a lease host-run sets `HRA_JOBS`, `CARGO_BUILD_JOBS`,
`NEXTEST_TEST_THREADS`, `RAYON_NUM_THREADS`, and `MAKEFLAGS=-jN` to
permits x cores / capacity when they are unset, and `RUSTC_WRAPPER=sccache`
only when sccache is already installed. Repository test configs should read
`HRA_JOBS` for worker counts.

For non-interactive macOS and Linux runs, the wrapper supervises a dedicated
child process group and forwards `HUP`, `INT`, `QUIT`, and `TERM` to the whole
group. An interactive TTY preserves its controlling terminal and receives
best-effort leader signaling so an intentional 2FA prompt still works. Do not
detach a background server from scheduler custody.

## Mac UI forwarding

A workstation, the Mac someone is using, does not run `mac-ui` work while
they use it. On a host with `~/.config/host-run/remote.json` (or
`$XDG_CONFIG_HOME/host-run/remote.json`):

```json
{ "macUi": { "forwardTo": "hra2" } }
```

`host-run --lane=mac-ui` forwards the run to that ssh host. Agents call it
exactly as they would locally; nothing else changes. Without the file the
lane runs locally, so CI and other machines are unchanged. With a
`presence` entry as well, UI work runs here while the owner is idle; see
[Presence-aware placement](#presence-aware-placement).

1. It reads the Git root, HEAD and `origin` of the working directory, finds
   the clone with the same origin under the remote `~/src`, and asks which
   commits it already has. When the remote has no clone, it sends a one-time
   copy (see [Seeding](#seeding)).
2. It sends a Git pack of the commits the remote clone lacks and a binary
   patch of every uncommitted change, untracked files included and ignored
   files excluded, in one ssh stream. The remote needs only the commits the
   new ones build on, even when no branch or tag there reaches them, as with
   a pull request fetched for a worktree. For a full clone, a changed file
   travels as a Git delta against its version in those commits, so a
   one-line edit to a large file stays small. A partial clone may never have
   fetched that version, so it gets the whole file. Nothing is pushed to
   origin. A temporary index is used, so the local index is untouched.
3. The remote side makes a `git clone --shared` throwaway tree under
   `~/.local/state/host-run/remote/<id>`, checks out the commit, applies the
   patch, and starts the same command under its own
   `host-run --lane=mac-ui` with the same mode, label and max hold. It runs
   as a launchd job in the user's GUI (Aqua) session, so windows, focus and
   automation behave as they do at the console. Existing checkouts, their
   index and their branches are never touched.
4. stdout and stderr stream back separately, and host-run exits with the
   remote command's exit code. `--artifacts=PATH` (repeatable, relative to the
   repository root) copies those paths back into the local repository after
   the run; a missing artifact is a warning.
5. The remote tree is removed afterwards. Ctrl-C, TERM or HUP asks the remote
   job to stop (TERM through its host-run), waits up to 2 min for its status,
   then cleans up. A second Ctrl-C disconnects at once; the remote side then
   stops the job itself, and removes run directories older than a day on its
   next run.

The workstation claims no local lease while a forwarded run waits or runs:
the run uses none of its scarce capabilities, and a lease held while waiting
on another host would block local work on external state. The receiving
Mac's own `mac-ui` lease, queue timeout and max hold govern the run.

It fails closed. If forwarding is configured but the host is unreachable, the
repository has no clone there and cannot be seeded, the commit cannot be shipped, the user has no
GUI session there, or the config is malformed, host-run exits 69
(`MAC_UI_FORWARD_FAILED`) with the reason and never runs the UI work locally
(with presence placement, it first waits for the owner to go idle).
`--local` runs it here anyway, for when the owner asks to watch it;
`--remote` forwards it even while the owner is idle. `LOCAL_EFFICIENCY_REMOTE_CONFIG=ABSOLUTE-PATH` points at a
different config file, which must exist. Environment variables and stdin are
not forwarded: put needed variables in the command (`env NAME=VALUE ...`).
Submodules are not forwarded. A run that was already forwarded refuses to
forward again.

### Seeding

When the remote has no clone with the same origin, host-run sends a full
`git bundle` of the repository over the same ssh connection and keeps it as
a bare repository in the remote's
`~/.local/state/host-run/seed/<host-path-of-origin>`. It never creates or
changes anything in the remote `~/src`. The seed's `origin` is the real
remote URL with any user name or token removed, so later runs match it, and
each later run sends only the commits it lacks and advances the seed. A real
clone in `~/src` wins over a seed when both exist.

- It prints the size before sending and the time after. It refuses a bundle
  larger than `seedMaxMiB` (default 2048) and a remote with less than
  20 GiB free; `"seedMaxMiB": 0` turns seeding off for that entry.
- It sends Git objects only. Credentials, Git config, hooks and Git LFS
  content stay on this Mac.

### Partial clones

A clone made with `--filter=blob:none` fetches file contents on demand, which
fails on a Mac without credentials for the origin. When the remote clone is a
partial clone, host-run asks it which of the commit's files and directories
it lacks (without letting it fetch), packs exactly those objects here, and
sends them in the same ssh stream with their count and size. The remote keeps
them in a host-run object store under `~/.local/state/host-run/fill/<name>`
that its throwaway trees and build workspaces read from, so each object
travels once. The clone in `~/src` is never written. The pack counts against
`seedMaxMiB`; when it is larger, or `seedMaxMiB` is 0, the run stops with
exit 69 and suggests running `git fetch` in that clone. A checkout that still
leaves tracked files out also stops with that reason, before the command
runs.

## Heavy compute forwarding

A workstation can send its heavy builds to a less loaded Mac. Add a
`compute` entry next to `macUi`:

```json
{ "compute": { "forwardTo": "hra2", "modes": ["heavy", "exclusive"] } }
```

`host-run --lane=compute --mode=heavy|exclusive` then runs on that host;
`shared` work, the default, always runs here. Without the entry nothing
changes. Use `--mode=heavy` for builds and repository-wide checks so they can
move.

- **Same transport.** HEAD, the commits the remote lacks, and a patch of
  uncommitted changes go over one ssh stream, as for `mac-ui`, with
  [seeding](#seeding) when the remote has no clone.
- **Cached workspace.** The remote keeps up to `slots` (default 2) worktrees
  per repository under `~/.local/state/host-run/compute/<repo>/slot-N`. Each
  run takes a free slot, resets it to the commit plus the patch
  (`checkout --force`, `git clean -ffd`, which keeps ignored output such as
  `target/` or `node_modules`), and runs there, so builds after the first are
  incremental. Two runs never share a slot; when every slot is busy the run
  waits. Idle slots are deleted, least recently used first, while free disk
  is under `minFreeGiB` (default 60) or the cache exceeds `cacheGiB`
  (default 80).
- **Remote scheduling.** The command runs under the remote's own
  `host-run --lane=compute` with the same mode, label and max hold (an hour
  when the run names none), and holds
  its CI machine lock shared when one is configured. It runs as a background
  child of the ssh session, not in the GUI session, at `nice` 10, so the
  remote's own work and CI come first. Background QoS (`taskpolicy -b`) is not
  used because it confines the build to efficiency cores and throttles its
  disk I/O.
- **Environment.** Only build settings travel: `CARGO_*`, `RUSTFLAGS`,
  `RUSTDOCFLAGS`, `RUST_BACKTRACE`, `RUST_LOG`, `RUST_TEST_THREADS`,
  `RUST_MIN_STACK`, `MAKEFLAGS`, `CMAKE_BUILD_PARALLEL_LEVEL`, `HRA_JOBS`,
  `CI`, `NODE_ENV`, `FORCE_COLOR`, `NO_COLOR`, `LANG`, `LC_ALL` and `TZ`.
  Names that look like tokens, secrets or keys, and values holding local
  paths, stay here; host-run lists what it did not send.
- **Results.** Output streams back and host-run exits with the remote exit
  code. A failure there is the answer: it is not rerun here. When the two
  Macs run different macOS or Xcode versions, a failure prints both.
- **Falls back, never fails.** If the host is unreachable, the directory is
  not in a Git repository, a submodule has changes, seeding is refused, or
  the remote cannot prepare the workspace, the command runs here with one
  line: `[host-run] running LABEL on this Mac: REASON`. A command that
  started on the remote never reruns here.
- **Long runs stay here.** A run whose `--max-hold` is over an hour, or
  `none`, runs on this Mac with one line:
  `[host-run] keeping LABEL on this Mac: REASON`. A forwarded run holds the
  remote's CI machine lock for its whole run, so a soak there could keep CI
  steps that need that Mac to themselves waiting for hours. With `--remote`,
  host-run refuses such a run (exit 69) instead. A forwarded run that names
  no hold is stopped after an hour there; give a longer run `--max-hold` or
  `--local`.

Pass `--local` to keep a heavy run on this Mac when it needs this Mac: its
outputs are used here (a binary to install or run, an app bundle, files
another local step reads), it reads local-only state, credentials or private
data, it binds a fixed port, or it talks to an attached device. Nested runs
inside a lease and `mac-native` runs, `--full-cpu` included, are never
forwarded.

## Presence-aware placement

A workstation that forwards work can also use it while its owner is not at
the keyboard. Add a `presence` entry next to `macUi` and `compute`:

```json
{
  "macUi": { "forwardTo": "hra2" },
  "compute": { "forwardTo": "hra2", "modes": ["heavy", "exclusive"] },
  "presence": { "keyIdleMinutes": 5 }
}
```

Before each `mac-ui` or heavy compute run, host-run checks whether the
owner is using this Mac and prints one line with its choice, such as
`[host-run] placing ui-tests on HRANESS1: owner idle 12m, no video or call`.
`host-run presence` prints the same check as JSON. The owner is:

- **typing** when a key was pressed in the last `keyIdleMinutes` (default
  5). Mouse and trackpad use alone, such as reading or browsing, does not
  count.
- **watching video** when an app holds a display-sleep assertion (`pmset -g
  assertions`), as browsers and players do during playback. Keep-awake tools
  (caffeinate, Amphetamine, KeepingYouAwake, Lungo, Theine) and processes
  started by agents or builds (anything under `claude`, `codex`,
  `cursor-agent`, `xcodebuild` or `ohd`) do not count.
- **on a call** when a microphone or camera is in use, or the Mac is being
  screen-shared. If the microphone and camera do not answer within 2 s, that
  counts as a call too.
- **away** when the screen is locked, every display is asleep, or the lid is
  closed with no external display.
- **idle** otherwise.

Where the work goes:

| Owner | `mac-ui` | heavy compute |
| --- | --- | --- |
| idle | here | here, if this Mac has the permits free and is no more loaded per core than the other Mac (or under 0.5 per core) |
| away | other Mac: UI tests need an unlocked, awake screen | here, on the same capacity test |
| typing, video or call | other Mac | other Mac |

- **The owner comes back during a UI run.** host-run rechecks every
  `pollSeconds` (default 2). On typing, video, a call or a lock it sends TERM
  to the run's process group, KILL after `graceSeconds` (default 15), TERM
  to any process the run started that left the group, and reruns the command
  on the other Mac. Apps that XCTest or `open` launched are not the run's
  children; XCTest closes the apps it launched when it is stopped. During a
  UI run, display-sleep assertions from processes started after the run
  began are ignored, so the app under test does not count as video; video in
  an app that was already open does.
- **The other Mac is unreachable.** A UI run waits, rechecking presence and
  retrying the other Mac each minute, for up to `waitMinutes` (default 60),
  then exits 69. It runs here as soon as the owner is idle, and never while
  they are busy. Heavy compute runs here instead, as before.
- **The owner comes back during a build here.** host-run never stops it. It
  moves the build's process tree to background priority (as
  `taskpolicy -b` does: lower CPU priority, efficiency cores, throttled disk)
  and back to normal once the owner is idle or away again. It checks every
  5 s.
- **Overrides.** `--local` keeps the run here and `--remote` sends it to
  the other Mac, which then fails closed with exit 69 and never runs here.
  Use `--remote` when a run must not take focus here even if the owner looks
  idle, such as testing host-run itself. Do not use `--local` to get around placement
  unless the owner asks.

Every signal is read without a privacy prompt or grant: key idle time comes
from the HID system's per-event idle counters, which need no Input
Monitoring access. A check takes about 25 ms once warm and up to about
150 ms the first time on a busy Mac. Presence placement needs macOS; elsewhere
host-run prints a line and places work as it did without it.

### CI machine lock

A Mac that also runs CI benchmarks can make `mac-ui` runs, and compute runs
forwarded to it, stay out of the way of timed measurements. Its own `~/.config/host-run/machine-lock.json`
(or `$XDG_CONFIG_HOME/host-run/machine-lock.json`) names the CI runners'
machine lock:

```json
{ "macUi": { "path": "/opt/ci-lock/machine.lock", "mode": "shared", "waitTimeoutSeconds": 3600 } }
```

Every `mac-ui` run on that Mac, forwarded or started there, and every
compute run forwarded to it, then holds the lock shared for the whole command. It speaks the runners'
`ci-machine-lock.py` protocol: `flock` on the file plus its `.gate`, so a
measurement waiting for the exclusive lock also holds back new UI runs.
host-run implements the protocol itself instead of running the runner's
script, which belongs to the CI account. Only `shared` is accepted.

- The lock is taken before the `mac-ui` lease, so no UI slot is held while
  CI measures. While blocked, host-run prints `waiting for the <host> CI
  machine lock`.
- The command never inherits the lock. It is released when host-run exits
  for any reason, including Ctrl-C or a forwarded cancel.
- A wait longer than `waitTimeoutSeconds` (default 3600, at most 7200) runs
  nothing and exits 76 (`MACHINE_LOCK_TIMEOUT`). Ctrl-C while waiting exits
  130.
- `LOCAL_EFFICIENCY_MACHINE_LOCK_CONFIG=ABSOLUTE-PATH` points at a different
  file, which must exist. A malformed file is an error, never a silent skip.

### Privacy permissions: the HostRun UI app

macOS gives Accessibility, Screen Recording, Input Monitoring and Automation
to the program launchd started, and everything it starts inherits them. For a
forwarded run that program is normally `/bin/bash`, and granting it would
give every shell on the Mac control of the screen. A Mac that runs UI tests
needing those permissions installs a small helper app instead:

```sh
host-run mac-ui install-helper     # builds ~/Applications/HostRun UI.app
host-run mac-ui helper-status      # app, bundle id, code hash, up to date or not
```

`install-helper` compiles the checked-in C launcher, signs it ad hoc as
`com.hraness.host-run-ui`, and writes `~/.config/host-run/mac-ui.json`
(`{ "helper": { "app": "..." } }`). From then on each forwarded run on that
Mac starts through the app, so the owner grants the permissions to
`HostRun UI.app` alone. Grants for an ad-hoc app follow its code hash, so the
install only rebuilds when the launcher's own source changes; a host-run
update or a new Xcode leaves the app, and its grants, alone. When the source
does change, `install-helper` says so and the grants must be given again.

- **What it runs.** Only the job script the remote side staged for this run.
  It refuses unless launchd started it as that run's job, the run directory
  is a private directory directly under `~/.local/state/host-run/remote`,
  and the command line carries the run's one-time token, which it deletes
  before starting. Any other argument list, a shell calling it directly, or a
  reused run directory exits 69. It never execs: the job stays its child, so
  the attribution holds, and it passes TERM, INT and HUP through and exits
  with the job's status.
- **What it does not stop.** Code already running as that user can stage a
  run directory and load a launchd job the same way the remote side does, and
  every command a forwarded run starts gets the permissions. The app keeps
  the permissions away from ordinary shells, ssh sessions and stray argv, not
  from the user account itself.
- **Fails closed.** When `mac-ui.json` exists but the app is missing, fails
  `codesign --verify`, or has another identifier, the run exits 69 before
  anything starts; it never falls back to `/bin/bash`. Without the file runs
  start through `/bin/bash` as before, which is fine for UI tests that need no
  privacy grants. Only forwarded runs use the app; a `mac-ui` run started at
  that Mac's own terminal keeps the terminal's permissions.
- **Probe.** `host-run mac-ui probe` prints the launchd job, the process
  chain, and whether Accessibility, Screen Recording, posting events, Input
  Monitoring and System Events UI scripting are allowed; it exits 1 if any is
  missing. Run it through forwarding to check what a forwarded run gets:
  `host-run --lane=mac-ui --label=tcc-probe -- host-run mac-ui probe`.

To grant, on that Mac open System Settings > Privacy & Security and, in each
of Accessibility, Screen Recording, and Input Monitoring, click +, press
Cmd-Shift-G, enter `~/Applications/HostRun UI.app`, and turn it on. The first
run that scripts System Events asks for Automation; allow it, or turn on
System Events under HostRun UI in Privacy & Security > Automation.

## Offloading whole tasks

host-run moves one command. When `oh-router` is installed, an agent can move
a whole independent task, such as a separate PR or a long build or test
investigation, to another device:

```sh
oh-router spawn --device auto --headless --cwd ABSOLUTE-REPO "SELF-CONTAINED BRIEF"
```

- **When.** The task needs no local browser, native device, private local
  data or uncommitted changes, and can finish as a pushed branch or PR. Write
  the brief so a fresh agent can finish it alone: the goal, the repository
  rules, and how to deliver.
- **Placement.** `--device auto` starts it on this device while it has a
  Ready lane and room for another headless session, otherwise on the trusted
  paired device with the fewest active sessions per core. `spawn` prints
  `placed on DEVICE: REASON` and the session id.
- **Follow it.** `oh-router ps` lists local and remote sessions;
  `oh-router inspect SESSION_ID` shows one session's state and screen,
  wherever it runs.
- **Results come through GitHub.** The remote works in a fresh worktree of
  its own clone, from origin's copy of the branch. Local commits that are not
  pushed and uncommitted changes stay here, and nothing is copied back.
  Collect the result as its pushed branch or PR.
- **Keep here.** Work for the `browser-auth`, `mac-ui` or `mac-native`
  lanes, and work that reads local-only state, credentials or private data,
  binds a fixed port or uses an attached device. A `--cwd` that is not a
  pushed GitHub checkout stays here.

## Resource modes

Use `shared` for one narrow check, `heavy` for production builds and ordinary
repository-wide checks, and `exclusive` for full monorepo validation, native
packaging, capture hardware, or timing-budget suites that need a quiet host
(`--lane=compute --mode=exclusive`). Headless browser suites are
`--lane=browser --mode=shared|heavy`; a fixed port is not a reason for
`exclusive`: take a port from `hra-port` instead.

Submit `exclusive` work only after its inputs converge. Strict FIFO prevents
starvation but can strand spare permits behind a waiting all-permit claim. If
that happens ahead of a known finite shared/heavy backlog, only the exclusive
claim's owner may cancel it before admission and requeue the identical command
after the backlog drains. Never interrupt an admitted command just to reorder
the queue, and never run its child outside the scheduler.

Known mappings:

- Jungle `check:affected`: heavy; Jungle full `check`: exclusive.
- Personal template and Tiff full check/build: heavy.
- Narrow file or package tests: normally unscheduled.

The wrapper runs the original public command unchanged. It does not substitute
a weaker check.

Each top-level scheduler attempt appends one bounded local telemetry record when
storage is available. A pre-admission scheduler error or catchable cancellation
has no admission timestamp or run duration; cancellation is recorded before the
waiting claim is released. Records contain timestamps, lane, mode, safe label, program
label, permit counts, queue and run durations, an exit class, a hashed workspace
identifier, and a command digest. They never contain raw argv, environment
values, paths, transcripts, reasoning, or tool output. Telemetry is best effort
and never changes the child command's result.

## Host-access boundary

The machine-wide scheduler state intentionally lives outside an ordinary
repository sandbox. Request reviewed host access for the top-level absolute
`host-run` invocation on the first attempt. This also applies to focused
process-custody and recovery tests: they exercise machine-scoped identity
and journal locks even when their CPU cost is small.

If the wrapper reports `HOST_ACCESS_REQUIRED` and exits 77, retry the
identical wrapper invocation once through Codex host-access approval or
configured auto-review. Preserve the working directory and every argument. If
the reviewed retry still returns 77, stop and diagnose the permission setup.
Never bypass the wrapper by running its child directly, remove scheduler or
recovery state, weaken fail-closed custody, or create an unconditional allow
rule for `host-run`; it can wrap arbitrary child commands.

The bootstrap sets Codex to `approval_policy = "on-request"`,
`approvals_reviewer = "auto_review"`, and `default_permissions = ":workspace"`.
It also manages a prompt-only Codex rule for the absolute installed wrapper.
The rule makes every complete invocation reviewable but grants no permission.
Codex loads configuration and rule files at task startup, so start a new task
after installing or updating the baseline.

When the installed Claude Code is at least 2.1.83 and
`claude auto-mode config` confirms that the CLI exposes a valid Auto-mode
configuration surface, the bootstrap sets
`permissions.defaultMode = "auto"` and inherits its built-in classifier rules
through `$defaults`. Because explicit allow rules resolve before the Auto
classifier, the bootstrap removes bare or universal whole-tool allows and every wildcarded
Bash or PowerShell allow while preserving exact commands, path-bounded
non-shell allows, and every deny. Claude may apply additional runtime filtering. It
does not globally declare sibling repositories or the public npm registry
trusted. The doctor reports the machine capability
decision. If the CLI does not expose that surface, bootstrap leaves the
ordinary permission setting untouched. Account, model, and organization
eligibility is enforced by Claude Code when a session starts rather than
attested by the configuration command; if that runtime gate refuses Auto mode,
use the ordinary permission mode and never fall back to bypass permissions.

## Validation receipts

`validation-run` fingerprints the Git HEAD, tracked diff, untracked file content
and executable/link mode, working directory, exact command, Bun/Node versions,
lockfiles, and caller contexts. It never follows untracked symlinks. Successful
receipts live under the repository's Git common directory
so linked worktrees can share exact evidence. Receipts and wrapper output retain
only a safe operation label, program name, and command digest—not raw argv or
context values. Reuse fails closed when the index contains skip-worktree or
assume-unchanged entries, a populated gitlink/submodule, or an unsupported
untracked file type.

Use `--reuse --ttl-minutes=N` only for deterministic focused commands. Force a
real run after relevant environment or external state changes. Failed commands
are reported for diagnosis but never reused as success.

## Complete-history CI

A complete-history policy is not permission to fetch every live branch. Start
from the exact governed SHA, disable credential persistence, and explicitly
fetch only the fully qualified branch, tag, or exact-SHA refs the policy owns.
Enumerate refs immediately afterward and reject any unexpected ref before the
history scan. Keep `rev-list --all` or the repository's equivalent complete
scan over that governed ref set.

Use `ci-ref-audit` as a conservative review aid. A broad fetch without a
complete-history consumer is informational, and a complete-history consumer
with an explicit governed ref set is compliant. Do not rewrite release history
fetches mechanically; tags and the stable branch may both be required inputs.

## Cleanup safety

Size is a discovery signal, not deletion authority. A removable worktree must
be registered, present, clean including untracked and ignored files, free of
skip-worktree and assume-unchanged index flags and populated gitlinks, neither
primary nor the invoking worktree, explicitly named, and merged into an exactly
fetched, fully qualified remote target. The cleanup script validates the full
manifest before deletion and revalidates every target at action time. It never
forces removal or deletes branches.

Treat unregistered temporary directories, Codex transcripts, application
databases, credentials, private corpora, archives, and dirty worktrees as user
state. Never sweep a temporary-path prefix.

At task closeout, record the applicable final branch, pull request, checks,
merge, release, deployment, and production readback. Archive only a
conclusively finished task; silence is not completion evidence. In the Codex
app, archiving a completed managed-worktree task lets the app snapshot and
reclaim its managed checkout. Permanent worktrees still require their own
guarded cleanup.

## Machine standard

`bootstrap.ts` manages one marked block in global Codex `AGENTS.md`, three
top-level Codex permission settings, one marked block in global Claude
`CLAUDE.md`, Claude's Auto-mode default, bounded environment, and broad-allow
cleanup, two optional
CLI profiles, a prompt-only host-access rule, a minimal private scheduler
runtime, and convenience commands. It preserves unrelated TOML, JSON, Markdown,
and rule content, leaves exact profile symlinks intact, and refuses unsafe
targets. Use `--check` in automation and after plugin upgrades.

This plugin ships in the `hraness-skillpack` marketplace
(`hraness/skillpack`, plugin `local-efficiency`). After installing or
upgrading it, rerun bootstrap and start a new Codex task so the refreshed
skill is discovered.
