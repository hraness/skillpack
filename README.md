# Hraness Agent Skills

[![skills.sh](https://skills.sh/b/hraness/skillpack)](https://skills.sh/hraness/skillpack)

**Pick a task. Get the method—and the boundary that keeps it honest.**

Hraness Agent Skills is a public, source-auditable collection of 33 workflows
for repository engineering, reviewed phased delivery, explicit semantic
reasoning, and safe distribution administration. Install only the packs you
need, then use them in the agent host you already work in.

Hraness is the publisher, not a product dependency. These skills do not
require or operate the Oompa application, CLI, account, or service.

## First proof

Take the shortest install path for a skills.sh-supported host:

```sh
npx skills add hraness/skillpack
```

Then ask for a concrete result:

| Request | Bounded owner | Result |
| --- | --- | --- |
| “Map this repository’s user-visible features and proof paths.” | `repository-feature-map` | A navigable map from capabilities to code, runtime flows, and validation surfaces |
| “Execute this existing multi-phase plan with implementers and reviewers.” | `phase-orchestrator` | Phase receipts, independent review, join gates, and final integration evidence |
| “Use `$assumption-audit` on this proposal.” | `assumption-audit` | An explicit assumption register, test agenda, and fallback |

Each result names its evidence and its stopping point. The skills do not turn a
repository request into a generic reasoning exercise or treat an install as
permission to bypass local policy.

## How the pack works

```text
request → one bounded owner → canonical SKILL.md → repository commands and gates → evidence
```

1. Agent Skills directories are the canonical product. Each `SKILL.md` says
   when to use the workflow and when not to use it.
2. Codex, Cursor, Agent Plugins, Copilot, and registry files are thin adapters
   over those same sources.
3. Routing fixtures test adjacent skills against each other so overlapping
   requests retain one primary owner.
4. The selected workflow uses the target repository’s instructions, commands,
   scheduler, CI, and delivery policy. It does not replace them.

## Choose only what fits

| Pack | Use it for | First useful result | Do not use it for |
| --- | --- | --- | --- |
| [`hraness-engineering`](plugins/hraness-engineering) | Understanding, testing, verifying, documenting, measuring, or safely refactoring one repository concern | A map, explanation, risk register, verifier, test, measurement, corrected document, or behavior-preserving change | Multi-phase delivery or generic semantic transforms |
| [`code-orchestrator`](plugins/code-orchestrator) | Writing or executing an explicitly multi-phase delivery plan | A dependency-ordered plan or reviewed phase-by-phase delivery | Host scheduling, CI policy, or ordinary one-owner coding |
| [`semantic-algos`](plugins/semantic-algos) | Explicitly requested semantic and reasoning transforms from Rob Cheung’s work | A named transform or inspectable Sem computation | Implicit coding-task routing or repository delivery |
| [`skillpack-admin`](plugins/skillpack-admin) | Auditing, adopting, checking drift in, or repairing this distribution | A read-only inventory or an explicit backup-first adoption plan | Product coding, Oompa operations, or compute scheduling |

Machine resource scheduling, browser lanes, validation receipts, and worktree
custody remain the separate responsibility of `oompa-local-efficiency`.

## Install in the host you already use

### Codex

Install the reviewed v0.2.1 release, select only the plugins you need, and then
start a fresh Codex task:

```sh
codex plugin marketplace add hraness/skillpack --ref v0.2.1
codex plugin add hraness-engineering@hraness-skillpack
codex plugin add code-orchestrator@hraness-skillpack
codex plugin add semantic-algos@hraness-skillpack

# Optional distribution tooling
codex plugin add skillpack-admin@hraness-skillpack
```

### Cursor

Before public Marketplace approval, individual developers can clone this
repository and copy or symlink a selected `plugins/<name>` directory into
`$HOME/.cursor/plugins/local`, then reload Cursor. Teams and Enterprise admins
can instead import the repository as a team marketplace. After Cursor review,
the three MIT-licensed plugins will be directly discoverable in Cursor’s
public Marketplace: `hraness-engineering`, `code-orchestrator`, and optional
`skillpack-admin`.

`semantic-algos` is not in the Cursor marketplace manifest because its
permission grant is not a recognized permissive open-source license. Its
source and explicit Cursor command adapters remain available here for
authorized direct use.

### GitHub Copilot CLI and compatible Agent Plugin hosts

This repository is a directly addable Copilot plugin marketplace:

```sh
copilot plugin marketplace add hraness/skillpack
copilot plugin marketplace browse hraness-skillpack
copilot plugin install hraness-engineering@hraness-skillpack
```

The portable root `plugin.json` files are the canonical Agent Plugins
manifests; `.github/plugin/marketplace.json` is the host adapter.

### Agent Skills-compatible hosts

Each `plugins/<plugin>/skills/<skill>/` directory is independently portable.
The root `skills.sh.json` groups the public inventory without changing skill
behavior.

## Evidence you can inspect

- 33 canonical `SKILL.md` sources across four packs.
- A discoverable inventory in [`catalog/catalog.json`](catalog/catalog.json).
- Pairwise ownership checks in
  [`catalog/routing-fixtures.json`](catalog/routing-fixtures.json).
- Exact upstream revisions and local path inventories in
  [`sources.lock.json`](sources.lock.json) and
  [`catalog/provenance.json`](catalog/provenance.json).
- Host manifest, registry, portability, provenance, and offline administration
  canaries in the repository check.

Install the pinned Bun version declared in `package.json`, then prove the
checkout from source:

```sh
bun install --frozen-lockfile
bun run check
```

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

## Boundaries

- Repository instructions and required gates remain authoritative.
- `code-orchestrator` coordinates reasoning and ownership; it is not a compute
  scheduler and does not replace CI, review, release, or merge policy.
- `semantic-algos` is explicit-only. It does not silently take over coding,
  testing, delivery, or operations requests.
- `skillpack-admin` manages this distribution only. It does not install or
  configure Oompa.
- Registry presence is discovery evidence, not a security endorsement. Review
  source, provenance, permission notes, and the selected release.
- Rob Cheung’s semantic material is included with attribution and permission;
  it is not represented as MIT-licensed.

The compact engineering set adapts selected ideas from
[PStack](https://github.com/cursor/plugins/tree/main/pstack). The other adapted
packs retain provenance to
[Code Orchestrator](https://github.com/kousun12/code-orchestrator) and
[Rob Cheung’s Semantic Algos](https://github.com/kousun12/semantic-algos).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
[PRIVACY.md](PRIVACY.md), [TERMS.md](TERMS.md), and
[SECURITY.md](SECURITY.md) before redistributing or adapting the pack.

## Questions

### Do I need Oompa?

No. Hraness publishes this repository, but the skills do not require the Oompa
application, CLI, account, or service.

### Which pack should I start with?

Start with `hraness-engineering` for ordinary repository work. Add
`code-orchestrator` only for an existing or requested multi-phase plan, invoke
`semantic-algos` only when you want a named transform, and install
`skillpack-admin` only when you manage this distribution.

### Will a skill override my repository’s instructions?

No. Repository instructions, validation commands, scheduling, CI, and delivery
policy remain controlling.

### Why are some directory listings deferred?

Public directories impose their own review and licensing requirements.
Repository source may remain available while a specific listing is deferred;
[`docs/distribution.md`](docs/distribution.md) records each channel and gate.

## Start with source

Review the pack that owns your task, install it from the v0.2.1 release, and
run one concrete request. Existing v0.1 installations should follow
[`docs/migration-v0.2.md`](docs/migration-v0.2.md). Distribution status lives
in [`docs/distribution.md`](docs/distribution.md), and staged retirement of
older repository-local copies is documented in
[`docs/rollout.md`](docs/rollout.md).
