# Semantic Algos

**Make the reasoning inspectable—only when you ask for it.**

Semantic Algos packages 19 explicit semantic operators from Rob Cheung’s work
as portable Agent Skills. Use a named operator for a bounded transform, or use
the Sem workflow to compile, run, and present an inspectable computation over
authorized text.

## First proof

Ask explicitly:

> Use `$assumption-audit` to expose the load-bearing premises in this proposal.

The operator returns an assumption register, keystone assumption, test agenda,
and fallback. It does not silently route an ordinary coding or delivery
request through semantic analysis.

## How it works

Two interfaces share one canonical source tree:

```text
named operator → bounded semantic transform → stated limits

request → sem-compile → inspectable program → sem-run → linked artifacts → sem-present → disposable view
```

The pack includes explicit transforms for assumptions, inversion, first
principles, counterfactuals, abstraction, explanations, decisions, questions,
analogies, why-chains, dynamic-programming decomposition, the Golden Circle,
parable, joke, lyric, and Nietzsche’s Camel–Lion–Child ladder. The `sem-*`
skills compile, execute, and present declared computations without turning
them into repository orchestration.

## Interfaces

- In Codex, invoke a canonical skill explicitly as `$skill-name`.
- In Cursor, invoke its thin command adapter as `/skill-name`.
- Agent Skills-compatible hosts read the canonical `skills/` directories.

Cursor’s `commands/` adapters point back to the same skill sources and contain
no duplicate procedure. `cursor-explicit-skills/` intentionally suppresses
automatic skill discovery so Cursor preserves the explicit-only contract.

## Evidence

- All 19 Codex skill metadata files set
  `policy.allow_implicit_invocation: false`.
- Cursor command names map one-to-one to canonical skill directories.
- `sem-compile`, `sem-run`, and `sem-present` keep checked contracts beside
  their skill sources.
- Routing fixtures exclude ordinary coding, repository analysis, testing,
  delivery, and operations.

Pinned upstream paths and the permission record are documented in
[`PROVENANCE.md`](PROVENANCE.md).

## Boundaries

- Invoke a semantic operator by name; the pack must not hijack ordinary work.
- Semantic execution may write only its declared artifacts. It does not
  authorize external effects.
- Sem computation is not repository delivery, multi-agent orchestration, test
  execution, or host scheduling.
- The pinned upstream revision has no published license file. This adaptation
  is attributed to Rob Cheung and used with permission; it is not described as
  MIT-licensed.

## Questions

### When should I use one operator instead of Sem?

Use a named operator for one bounded transform. Use `sem-compile`, `sem-run`,
and optionally `sem-present` when the computation needs explicit dependencies,
isolated execution, linked traces, or a checked view.

### Why is invocation explicit?

Reasoning transforms can materially reframe a request. Explicit invocation
keeps that choice with the user and prevents overlap with repository work.

### Why is Cursor Marketplace distribution different?

Cursor’s public Marketplace requires a recognized permissive open-source
license. The source and direct-use adapters remain here under the recorded
permission, but the public Cursor listing is excluded unless the licensing
gate changes.

## Start

Review the named operator or Sem contract first, then install `semantic-algos`
for authorized direct use through a supported path in the
[`Hraness Agent Skills` README](../../README.md#install-in-the-host-you-already-use).
