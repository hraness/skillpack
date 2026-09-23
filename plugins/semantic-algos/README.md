# Semantic Algos

Semantic Algos packages 19 Agent Skills from Rob Cheung’s work, adapted with
permission. Sixteen are named reasoning methods, such as an assumption audit,
inversion, or first-principles thinking. The other three compile, run, and
present a Sem computation over text you provide, so you can inspect each
step. Each skill is meant to run only when you ask for it by name. Codex
enforces that, Cursor does when the pack is installed as a Cursor plugin, and
other hosts follow the skill’s description.

## Try it

Ask by name:

> Use `$assumption-audit` to expose the load-bearing premises in this proposal.

The skill returns the proposal’s assumptions, the one it depends on most, a
way to test each, and a fallback. It is not for ordinary coding or delivery
requests.

## How it works

The pack offers two ways to use the same skills:

```text
named method → one reasoning transform → its stated limits

request → sem-compile → program you can read → sem-run → linked Markdown files → sem-present → a view you can discard
```

The named methods cover assumptions, inversion, first principles,
counterfactuals, abstraction, explanations, decisions, questions, analogies,
why-chains, dynamic-programming decomposition, the Golden Circle, parable,
joke, lyric, and Nietzsche’s camel, lion, and child ladder. The `sem-*` skills
compile, execute, and present a declared computation without turning it into
repository orchestration.

## Interfaces

- In Codex, invoke a skill by name as `$skill-name`.
- In Cursor, invoke its command as `/skill-name`.
- Agent Skills hosts read the `skills/` directories.

Cursor’s `commands/` files point back to the same skills and repeat none of
their steps. `cursor-explicit-skills/` turns off automatic skill discovery in
Cursor, so the skills run only when named there too.

## Checks

- All 19 Codex skill metadata files set
  `policy.allow_implicit_invocation: false`.
- Each Cursor command maps to exactly one skill directory.
- `sem-compile`, `sem-run`, and `sem-present` keep their format definitions
  next to their skill files.
- Routing fixtures exclude ordinary coding, repository analysis, testing,
  delivery, and operations.

Pinned upstream paths and the permission record are documented in
[`PROVENANCE.md`](PROVENANCE.md).

## Limits

- Invoke a skill by name. The skills are not meant to take over ordinary work.
- A Sem run may write only the files it declares. It does not authorize
  actions outside them.
- A Sem computation is not repository delivery, multi-agent orchestration,
  test execution, or host scheduling.
- The pinned upstream revision has no published license file. This adaptation
  is attributed to Rob Cheung and used with permission; it is not described as
  MIT-licensed.

## Questions

### When should I use one method instead of Sem?

Use a named method for a single transform. Use `sem-compile`, `sem-run`, and
optionally `sem-present` when the computation needs declared dependencies,
isolated execution, linked traces, or a view you can check.

### Why do the skills run only by name?

A reasoning method can reframe a request. Running only by name keeps that
choice with you and keeps the skills out of ordinary repository work.

### Why is the Cursor Marketplace listing different?

Cursor’s public Marketplace requires a recognized permissive open-source
license. The source and direct-use commands stay here under the recorded
permission, but the pack is left out of the public Cursor listing unless the
license changes.

## Start

Read the named method or the Sem format first, then install `semantic-algos`
for direct use through one of the paths in the
[`Hraness Agent Skills` README](../../README.md#install-in-the-host-you-already-use).
