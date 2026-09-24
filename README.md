# Hraness Agent Skills

[![skills.sh](https://skills.sh/b/hraness/skillpack)](https://skills.sh/hraness/skillpack)

Hraness Agent Skills is a public collection of 33 workflows for AI coding
agents, in four packs. Eleven cover work in one repository: mapping it,
explaining how code behaves, assessing a change, writing tests, measuring
performance, updating docs, and refactoring without changing behavior. Two
plan multi-phase work and carry it out with independent review of each phase.
Nineteen come from Rob Cheung’s Semantic Algos: 16 named reasoning methods and
three skills that compile, run, and present Sem computations. The last one
manages installed copies of this pack. Every skill’s source is in this
repository. Install only the packs you need, in the agent host you already use.

You don’t need a Hraness account, app, or service to use these skills.

## Try it

Install from skills.sh in any host it supports:

```sh
npx skills add hraness/skillpack
```

Then ask for a concrete result:

| Request | Skill | Result |
| --- | --- | --- |
| “Map this repository’s user-visible features and where each is tested.” | `repository-feature-map` | A map from each feature to its entry points, code, runtime flow, and the checks that cover it |
| “Execute this existing multi-phase plan with implementers and reviewers.” | `phase-orchestrator` | Each phase implemented and reviewed independently, then one final integration with its validation results |
| “Use `$assumption-audit` on this proposal.” | `assumption-audit` | The proposal’s assumptions, the one it depends on most, a way to test each, and a fallback |

Each result says what evidence it rests on and where the skill stopped. Your
repository’s own instructions and checks still apply.

## How the pack works

```text
request → one skill → its SKILL.md → your repository's commands and checks → result with evidence
```

1. Each skill is a standard Agent Skills directory. Its `SKILL.md` says when
   to use the workflow and when not to.
2. The Codex, Cursor, Copilot, Agent Plugins, and registry files are small
   manifests that point at those same directories.
3. Routing fixtures list requests that fall between two similar skills and
   record which skill should handle each one.
4. The skill follows the target repository’s instructions, commands,
   scheduler, CI, and delivery policy, and does not replace them.

## Choose only what fits

| Pack | Use it for | First useful result | Not for |
| --- | --- | --- | --- |
| [`hraness-engineering`](plugins/hraness-engineering) | Understanding, testing, verifying, documenting, measuring, or refactoring one part of a repository | A map, explanation, risk register, app verifier, test, measurement, corrected document, or behavior-preserving change | Multi-phase delivery or reasoning methods |
| [`code-orchestrator`](plugins/code-orchestrator) | Writing or carrying out a plan with several phases | A dependency-ordered plan, or delivery phase by phase with review | Host scheduling, CI policy, or ordinary single-task coding |
| [`semantic-algos`](plugins/semantic-algos) | Reasoning methods from Rob Cheung’s work, meant to run only when you name them | The output of one named method, or a Sem computation you can inspect | Ordinary coding tasks or repository delivery |
| [`skillpack-admin`](plugins/skillpack-admin) | Auditing, adopting, checking drift in, or repairing installed copies of this pack | A read-only inventory or an adoption preview; a changed copy is overwritten only by a repair, which backs it up first | Product coding or compute scheduling |

A separate skill, `local-efficiency`, schedules heavy commands, browser
sessions, and worktrees on Hraness development machines. This pack does not
include it.

## Install in the host you already use

### Codex

Install the v0.2.2 release, add only the plugins you need, and then start a
fresh Codex task:

```sh
codex plugin marketplace add hraness/skillpack --ref v0.2.2
codex plugin add hraness-engineering@hraness-skillpack
codex plugin add code-orchestrator@hraness-skillpack
codex plugin add semantic-algos@hraness-skillpack

# Optional distribution tooling
codex plugin add skillpack-admin@hraness-skillpack
```

### Cursor

The three MIT-licensed plugins (`hraness-engineering`, `code-orchestrator`,
and the optional `skillpack-admin`) are prepared for Cursor’s public
Marketplace but not yet approved there. Until they are, clone this repository,
copy or symlink a `plugins/<name>` directory into
`$HOME/.cursor/plugins/local`, and reload Cursor. Teams and Enterprise admins
can instead import the repository as a team marketplace.

`semantic-algos` is not in the Cursor marketplace manifest because Rob
Cheung’s permission is not a recognized permissive open-source license. Its
source and Cursor command adapters are available here for direct use under
that permission.

### GitHub Copilot CLI and compatible Agent Plugin hosts

This repository is a directly addable Copilot plugin marketplace:

```sh
copilot plugin marketplace add hraness/skillpack
copilot plugin marketplace browse hraness-skillpack
copilot plugin install hraness-engineering@hraness-skillpack
```

Each pack’s `plugin.json` is its Agent Plugins manifest, and
`.github/plugin/marketplace.json` lists the packs for Copilot.

### Agent Skills-compatible hosts

Each `plugins/<plugin>/skills/<skill>/` directory is independently portable.
The root `skills.sh.json` groups the public inventory without changing skill
behavior.

## Check the source

- 33 `SKILL.md` files across four packs.
- An inventory of every skill in [`catalog/catalog.json`](catalog/catalog.json).
- Routing cases for overlapping skills in
  [`catalog/routing-fixtures.json`](catalog/routing-fixtures.json).
- The upstream revision and file list for each adapted skill in
  [`sources.lock.json`](sources.lock.json) and
  [`catalog/provenance.json`](catalog/provenance.json).
- Checks for host manifests, registry files, portability, provenance, and the
  offline admin tools, all run by the repository check.

Install the Bun version pinned in `package.json`, then run the checks from a
clone:

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

## Limits

- Your repository’s instructions and required checks take precedence.
- `code-orchestrator` plans the work and assigns each part to one owner. It
  does not schedule compute or replace CI, review, release, or merge policy.
- `semantic-algos` skills are meant to run only when you name them. Codex
  enforces this, and so does Cursor when you install the pack as a Cursor
  plugin. They are not for coding, testing, delivery, or operations requests.
- `skillpack-admin` manages installed copies of this pack and nothing else.
- A registry listing helps you find the pack; it is not a security review.
  Review the source, provenance, permission notes, and the release you install.
- Rob Cheung’s semantic material is included with attribution and permission
  and is not represented as MIT-licensed.

The compact engineering set adapts selected ideas from
[PStack](https://github.com/cursor/plugins/tree/main/pstack). The other adapted
packs retain provenance to
[Code Orchestrator](https://github.com/kousun12/code-orchestrator) and
[Rob Cheung’s Semantic Algos](https://github.com/kousun12/semantic-algos).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
[PRIVACY.md](PRIVACY.md), [TERMS.md](TERMS.md), and
[SECURITY.md](SECURITY.md) before redistributing or adapting the pack.

## Questions

### Do I need a Hraness account or app?

No. Hraness publishes the skills, and they run in your agent host.

### Which pack should I start with?

Start with `hraness-engineering` for ordinary repository work. Add
`code-orchestrator` only for an existing or requested multi-phase plan, invoke
`semantic-algos` only when you want a named transform, and install
`skillpack-admin` only when you manage this distribution.

### Will a skill override my repository’s instructions?

No. Your repository’s instructions, validation commands, scheduling, CI, and
delivery policy still apply.

### Why are some directory listings deferred?

Public directories set their own review and licensing requirements. The
source stays available here while a listing waits, and
[`docs/distribution.md`](docs/distribution.md) records each channel and what it
requires.

## Get started

Read the skill for your task, install its pack from the v0.2.2 release, and
try one concrete request. Existing v0.1 installations should follow
[`docs/migration-v0.2.md`](docs/migration-v0.2.md). Distribution status lives
in [`docs/distribution.md`](docs/distribution.md), and staged retirement of
older repository-local copies is documented in
[`docs/rollout.md`](docs/rollout.md).

## Optional development support

[Support Hraness development](https://account.hraness.com/support?product=hraness&source=skill#support)
if these skills help your work. Membership is optional general support for
Hraness, which publishes and maintains these skills.

The original `skillpack-admin` skill can offer this option after a useful
human-facing result, using its bundled local cadence and opt-out helper.
The engineering, orchestration, and semantic skills do not include this
invitation. No account or payment is needed to use any skill.
