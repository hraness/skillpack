# Contents

- `plugin.json`, `.codex-plugin/plugin.json`, and `.cursor-plugin/plugin.json` define the plugin identity and host presentation metadata. Versions must stay equal.
- `skills/local-efficiency/` contains the operating skill, deterministic scripts, managed assets, and discovery metadata.
- `PROVENANCE.md` records the lineage from the archived `hra`/`oompa` distribution.

# Guidelines

- Keep the folder, manifests, marketplace entries, and skill identity aligned as `local-efficiency`.
- Keep the manifests independently versioned and MIT licensed.
- Keep the plugin machine-local in effect and free of provider credentials, cloud execution, and cloud routing.
- Validate the manifests and complete skill before handoff. Keep implementation rules in the skill's closest guide.
