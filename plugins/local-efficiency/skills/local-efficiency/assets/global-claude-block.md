<!-- hraness-delivery:start -->
## Approval autonomy

- Use Claude Code auto mode when it is available. Treat its classifier and configured permission boundaries as the reviewer; never bypass them with a dangerous permission override.
- Treat the user's task request and repository instructions as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, and deployments after the repository's required validation and gates pass. Do not ask for a duplicate confirmation.
- Prefer repository-owned workload identities, OIDC trusted publishing, GitHub Apps, and narrowly scoped machine identities over personal sessions or long-lived credentials. Keep provider and repository access controls intact.
- Ask the user only for a material product choice, missing authority or credentials, an out-of-scope destructive action, or a release failure that cannot be handled safely and autonomously.

## Local scheduling

- Run broad builds, repository-wide checks and full gates, native work, packaging, and browser suites through `host-run` when it is installed (`host-run --mode=shared|heavy|exclusive --lane=compute|browser|browser-auth|mac-native --label=LABEL -- COMMAND ...`), unless the repository's own check script already schedules itself. Narrow single-file checks need no lease.
- Use `--lane=browser` for headless agent-browser/Playwright/Chromium checks and `--lane=browser-auth` only for the user's signed-in browser or a headed login. Static servers, dev/preview servers, and CI, merge-queue, or deploy wait loops never go in a browser lane; do not hold any lease while waiting on external state.
- The Bash tool times out at 10 min. Start long gates, and any host-run command that may queue, with `run_in_background` and wait for the completion notification instead of polling. A queued host-run prints who holds the lane and gives up after 2 h; a lease past its max hold (exclusive 60 min, browser 20, browser-auth 45) is terminated, so pass `--max-hold=DURATION` with a reason when a run needs longer.
- Serve dev servers on `${PORT:-$(hra-port NAME)}` bound to 127.0.0.1 and stop them before the task ends; never leave a background server or `&`/`nohup` process behind. Do not launch Google Chrome directly; use agent-browser or `hra-chrome`, and give one-shot `--screenshot` runs a timeout. When the signed-in Chrome is itself the blocker, restart it through `host-run --lane=browser-auth -- hra-chrome-restart` (`hra-chrome-restart` alone when host-run is absent); never force-kill it.
- On `HOST_ACCESS_REQUIRED` (exit 77), retry the identical host-run invocation once with reviewed host access; never run the child directly or delete scheduler state.
<!-- hraness-delivery:end -->
