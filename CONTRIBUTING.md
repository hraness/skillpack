# Contributing

Contributions should keep one clear owner for each request class and retain the
canonical Agent Skills shape: `plugins/<plugin>/skills/<skill>/SKILL.md`.

## Change workflow

1. Read `AGENTS.md` and the target skill's positive and negative boundaries.
2. Make the smallest bounded change and preserve unrelated work.
3. Add or update routing fixtures for changed ownership.
4. For adaptations, add exact immutable upstream provenance and attribution;
   never guess a revision or license.
5. Add offline tests for helpers or validator behavior.
6. Run the focused test, then `bun run check` on the converged tree.

New skills require a unique lower-case hyphenated name matching their folder,
a useful description containing both “Use when” and “Do not use”, catalog and
provenance entries, at least one positive and negative routing fixture, and a
pairwise ownership fixture against every adjacent skill named in the catalog.

References must be repository-relative, exist with exact case, and remain
inside the skill directory. Avoid private paths, credentials, host-specific
home-directory assumptions, model names, cloud runners, and placeholder text.

## Adapted material

Before adapting content, confirm the upstream terms permit the intended use.
Record the canonical URL, full immutable revision, upstream paths, license, and
local paths in `sources.lock.json`; add a notice when attribution or special
terms require it. `LICENSE` does not cover third-party material.

Generated output is not evidence by itself. Contributor claims should include
the exact command, exit status, relevant tree revision, and artifact path or
hash when applicable.
