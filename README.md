# Hraness Skillpack

Hraness Skillpack is a portable, source-auditable distribution of Agent Skills
for bounded engineering analysis, explicit semantic transforms, planned
multi-phase delivery, and management of the pack itself. Agent Skills
directories are canonical; Codex and Cursor metadata are intentionally thin
adapters over the same `SKILL.md` sources.

## Boundaries

| Skill | Owns | Does not own |
| --- | --- | --- |
| `hraness-engineering` | Repository analysis, verification, tests, performance, documentation, and behavior-preserving refactors | Delivery orchestration or implicit semantic routing |
| `code-orchestrator` | Multi-phase repository delivery after a phase plan exists | Host scheduling, CI policy, merge policy, or ordinary one-step coding |
| `semantic-algos` | Explicit semantic and reasoning transforms | General coding, repository analysis, or delivery routing |
| `hra-skillpack` | Install, audit, adoption, drift detection, and repair | Product coding or coding-task routing |

The pack never supplies cloud execution, a second compute scheduler, or a way
around repository gates. A skill is instructions, not proof: target-repository
commands, artifacts, and gates remain authoritative.

The structure follows the [Agent Skills specification](https://agentskills.io/specification),
[OpenAI's skill guidance](https://learn.chatgpt.com/docs/build-skills), and
[Cursor's skill](https://prod.cursor.com/docs/skills) and
[plugin](https://prod.cursor.com/docs/plugins) formats. The compact engineering
set adapts selected ideas from [PStack](https://github.com/cursor/plugins/tree/main/pstack)
instead of importing its full routing surface. The separate optional packs
retain provenance to [Code Orchestrator](https://github.com/kousun12/code-orchestrator)
and [Rob Cheung's Semantic Algos](https://github.com/kousun12/semantic-algos).

## Validate from source

Install the pinned Bun version declared in `package.json`, then run:

```sh
bun install --frozen-lockfile
bun run check
```

The check validates skill identity and uniqueness, routing ownership,
descriptions, references, manifests, provenance, portability, and placeholders;
then it runs offline canary tests for audit, adoption, drift, and repair.

## Audit without changing anything

```sh
bun plugins/hra-skillpack/scripts/audit.mjs --root .
```

Audit reports discovered skills and, when `--target` is supplied, compares an
installed skills directory against source content hashes. It never writes.

## Preview or apply adoption

The destination is always explicit. Preview is the default:

```sh
bun plugins/hra-skillpack/scripts/adopt.mjs \
  --source . --target ./local-agent-skills --skill hra-skillpack
```

Add `--apply` to copy a skill into an unused destination. Existing differing
skills are refused. To repair a known pack-managed skill, add both `--repair`
and `--apply`; the helper creates a sibling backup before overwriting known
source files and never deletes extra destination files.

To preview every discoverable skill, replace `--skill hra-skillpack` with
`--all`. `sync.mjs` is an equivalent all-skills entry point intended for drift
repair. No helper discovers or writes a host-specific home directory.

## Host marketplaces

- Codex reads `.agents/plugins/marketplace.json` and each plugin's
  `.codex-plugin/plugin.json`.
- Cursor reads `.cursor-plugin/marketplace.json`. Engineering, orchestration,
  and lifecycle plugins point at the canonical skill directories. Semantic
  operators use thin slash-command adapters because Cursor and Codex encode
  explicit-only invocation differently; the procedure remains canonical under
  `plugins/semantic-algos/skills/`.
- Other Agent Skills-compatible hosts can consume the individual directories
  below `plugins/*/skills/`.

Host installation commands change over time; follow the host's current
documentation and inspect the local marketplace before enabling it.

## Provenance and release integrity

`catalog/catalog.json` is the discoverable skill inventory.
`catalog/routing-fixtures.json` specifies positive, negative, and pairwise
ownership examples. `catalog/provenance.json` classifies every skill as
original or adapted. Adapted content is rejected unless `sources.lock.json`
pins an immutable upstream revision and local paths.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
[SECURITY.md](SECURITY.md), and [CONTRIBUTING.md](CONTRIBUTING.md) before
importing upstream material or changing routing boundaries.

The staged machine and repository migration is documented in
[docs/rollout.md](docs/rollout.md). The initial local sample found 48 drifted
name collisions across 27 repositories, so the safe rollout installs the
shared marketplace first and retires repository copies only through their own
reviewed paths.
