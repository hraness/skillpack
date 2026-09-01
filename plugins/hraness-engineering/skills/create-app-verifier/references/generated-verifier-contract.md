# Generated verifier contract

## Layout

```text
<project-skill-root>/verify-<app>/
  SKILL.md
  agents/openai.yaml
  references/features/
    README.md
    <feature>.md
  scripts/                 # only when the verifier owns a reusable driver
```

The folder name and frontmatter `name` must be the same lower-case `verify-<app>` value.

## Required `SKILL.md` content

### Doctor

One read-only command or bounded procedure must answer whether the instance is safe to drive. Check the expected build or revision, process ownership, port, disposable profile or data directory, readiness, and required test authentication. Refuse the drive when identity or ownership is ambiguous.

### Launch

Give exact commands, readiness evidence, supported isolation, and teardown ownership. Record process identifiers or another exact ownership marker. Never rely on killing by process name.

### Drive

Document real user paths with stable handles such as accessibility names, commands, routes, or public API calls. Prefer observable state transitions over coordinates and fixed sleeps. Internal setters and test-only shortcuts do not prove the production path.

### Evidence

Capture the triggering action and stable outcome together. Add a second observation for side effects such as persisted data, files, network requests, messages, or reload behavior. Name an artifact location outside disposable runtime state and keep secrets out of captures.

### Cleanup

Remove only processes and scratch state created by this run. Cleanup must be idempotent, safe after a partial failure, and preserve evidence. Provide dry-run behavior for any cleanup whose ownership cannot be made self-evident.

### Feature Map

`references/features/README.md` is the index and broad-sweep order. Each feature file contains:

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with <harness>`
4. `Gotchas`

Record prerequisites, every meaningful user entry point, exact drive steps, observable proof, and known unreachable paths. Keep implementation detail out unless it is required to operate the harness.

## Helper quality

A helper must expose useful help, descriptive failures, machine-readable output where composition benefits, and explicit nonzero exit status. The verifier documents every helper invocation; a later agent should not need to reverse-engineer it.
