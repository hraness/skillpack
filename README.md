# Hraness Agent Skills

[![skills.sh](https://skills.sh/b/hraness/skillpack)](https://skills.sh/hraness/skillpack)

Hraness Agent Skills is a public, source-auditable collection of general-purpose
Agent Skills. **Hraness is the publisher, not a product dependency.** These
skills do not require or operate the HRA application, CLI, or service.

Agent Skills directories are canonical. Codex, Cursor, Agent Plugins, and
registry metadata are thin distribution adapters over the same `SKILL.md`
sources.

## Choose what to install

### Public capability packs

| Plugin | Use it for | Do not use it for |
| --- | --- | --- |
| `hraness-engineering` | Understanding, testing, verifying, documenting, measuring, or safely refactoring a repository | Multi-phase delivery or generic semantic transforms |
| `code-orchestrator` | Writing or executing an explicitly multi-phase delivery plan with bounded workers and independent review | Host scheduling, CI policy, or ordinary one-owner coding |
| `semantic-algos` | Explicitly requested semantic and reasoning transforms from Rob Cheung's work | Implicit coding-task routing or repository delivery |

### Optional distribution administration

`skillpack-admin` audits, adopts, checks drift in, and repairs installations of
this repository. Most people do not need it for ordinary engineering work. It
is not a skill for using HRA.

Machine resource scheduling, browser lanes, validation receipts, and worktree
custody remain the separate responsibility of `hra-local-efficiency`.

## Install

### Any host supported by skills.sh

```sh
npx skills add hraness/skillpack
```

The skills.sh repository page groups all skills by capability pack. Review the
source before installing; this repository never treats registry presence as a
security endorsement.

### Codex

Install the reviewed v0.2.0 release, select only the plugins you need, and then
start a fresh Codex task:

```sh
codex plugin marketplace add hraness/skillpack --ref v0.2.0
codex plugin add hraness-engineering@hraness-skillpack
codex plugin add code-orchestrator@hraness-skillpack
codex plugin add semantic-algos@hraness-skillpack

# Optional distribution tooling
codex plugin add skillpack-admin@hraness-skillpack
```

### Cursor

Before public Marketplace approval, individual developers can clone this
repository and copy or symlink a selected `plugins/<name>` directory into
`$HOME/.cursor/plugins/local`, then reload Cursor. Teams and Enterprise admins can
instead import the repository as a team marketplace. After Cursor review, the
three MIT-licensed plugins will be directly discoverable in Cursor's public
Marketplace: `hraness-engineering`, `code-orchestrator`, and optional
`skillpack-admin`.

`semantic-algos` is not in the Cursor marketplace manifest because its
permission grant is not a recognized permissive open-source license. Its
source and explicit Cursor command adapters remain in this repository for
authorized direct use.

### Agent Skills-compatible hosts

Each `plugins/<plugin>/skills/<skill>/` directory is independently portable.
The root `skills.sh.json` provides public grouping metadata without changing
skill behavior.

### GitHub Copilot CLI and compatible Agent Plugin hosts

This repository is also a directly addable Copilot plugin marketplace:

```sh
copilot plugin marketplace add hraness/skillpack
copilot plugin marketplace browse hraness-skillpack
copilot plugin install hraness-engineering@hraness-skillpack
```

The portable root `plugin.json` files are the canonical Agent Plugins
manifests; `.github/plugin/marketplace.json` is only the host adapter.

## Validate from source

Install the pinned Bun version declared in `package.json`, then run:

```sh
bun install --frozen-lockfile
bun run check
```

The check validates skill identity, routing ownership, references, manifests,
provenance, registry metadata, portability, and offline administration
canaries.

## Audit or adopt safely

Audit is read-only:

```sh
bun plugins/skillpack-admin/scripts/audit.mjs --root .
```

Adoption previews by default and always requires an explicit destination:

```sh
bun plugins/skillpack-admin/scripts/adopt.mjs \
  --source . --target ./local-agent-skills --skill skillpack-admin
```

Add `--apply` only after reviewing the plan. Repair requires both `--repair`
and `--apply`, creates a sibling backup, and never deletes extra destination
files.

## Provenance and licensing

The compact engineering set adapts selected ideas from
[PStack](https://github.com/cursor/plugins/tree/main/pstack) rather than
importing its full routing surface. The separate optional packs retain
provenance to [Code Orchestrator](https://github.com/kousun12/code-orchestrator)
and [Rob Cheung's Semantic Algos](https://github.com/kousun12/semantic-algos).
Rob Cheung's semantic material is included with attribution and permission; it
is not represented as MIT-licensed.

`catalog/catalog.json` is the discoverable skill inventory,
`catalog/routing-fixtures.json` proves pairwise ownership, and
`catalog/provenance.json` plus `sources.lock.json` pin adapted sources to exact
revisions. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
[PRIVACY.md](PRIVACY.md), [TERMS.md](TERMS.md), and
[SECURITY.md](SECURITY.md) before redistributing or adapting the pack.

Registry and marketplace publication details are maintained in
[docs/distribution.md](docs/distribution.md). The staged retirement of older
repository-local copies is documented in [docs/rollout.md](docs/rollout.md).
Existing v0.1 installations should follow
[docs/migration-v0.2.md](docs/migration-v0.2.md).
