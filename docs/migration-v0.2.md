# Migrate from v0.1 to v0.2

Version 0.2 clarifies that this repository is a general Agent Skills
distribution published by Hraness. It is not a product integration.

## Identity change

| v0.1 | v0.2 | Meaning |
| --- | --- | --- |
| Plugin `hra-skillpack` | Plugin `skillpack-admin` | Optional distribution audit, adoption, drift, and repair |
| Skill `$hra-skillpack` | Skill `$skillpack-admin` | The single entry point for those administration operations |

The plugin IDs `hraness-engineering`, `code-orchestrator`, and
`semantic-algos` and every skill name inside those plugins remain stable.

## Codex migration

Remove the old admin plugin, update the marketplace to the versioned v0.2.1
release, and install the renamed plugin only if you use its administration
features:

```sh
codex plugin remove hra-skillpack@hraness-skillpack
codex plugin remove hraness-engineering@hraness-skillpack
codex plugin remove code-orchestrator@hraness-skillpack
codex plugin remove semantic-algos@hraness-skillpack
codex plugin marketplace remove hraness-skillpack
codex plugin marketplace add hraness/skillpack --ref v0.2.1
codex plugin add hraness-engineering@hraness-skillpack
codex plugin add code-orchestrator@hraness-skillpack
codex plugin add semantic-algos@hraness-skillpack
codex plugin add skillpack-admin@hraness-skillpack
codex plugin list --json
```

The final list should report version `0.2.1` for all four plugins and no
`hra-skillpack@hraness-skillpack` entry. If the old installation contained
only a subset, apply the same remove/re-add sequence only to that subset and
omit optional `skillpack-admin` if its administration features are not needed.
Then start a fresh Codex task so plugin metadata reloads.

## Cursor migration

Refresh the Hraness team marketplace or explicitly reviewed local plugin links,
then reload Cursor. The submitted public Cursor marketplace contains only the
MIT-licensed plugins. Existing direct-use semantic command adapters are not
deleted, but `semantic-algos` is not advertised in the public Cursor listing
without an accepted permissive license.

## Safety and verification

Do not keep both old and new admin plugin identities active: they expose the
same operation and create avoidable routing ambiguity. Run `$skillpack-admin`
in audit mode after migration and review every reported repository-local
collision before retiring a duplicate.

The repair tooling continues to write backups under the historical
`.hra-skillpack-backups` directory. That compatibility path is intentional and
must not be bulk-renamed or deleted.
