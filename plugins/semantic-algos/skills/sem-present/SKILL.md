---
name: sem-present
description: >-
  Explicitly invoked projection of one named existing Sem run into a bounded,
  validated view manifest without executing, resuming, or rendering the run.
  Use only when the user invokes $sem-present with an exact run directory. Do
  not use for repository visualization, coding, delivery, or operations.
---

# Sem Present

Run only when explicitly invoked with one exact existing run directory. Never
select the latest run by title, glob, timestamp guess, or semantic similarity.

Read [references/view-contract.md](references/view-contract.md) before writing.

1. Resolve the named run and reject paths outside it.
2. Read the authoritative Markdown trace without running or repairing it.
3. Reconstruct applications, dependencies, groups, results, retries, failures,
   and presentation roots from explicit run evidence. Mark inference as a
   warning rather than a fact.
4. Write only `view/manifest.json` and `view/notes.md` inside the run root.
5. Validate IDs, relative contained paths, references, status consistency,
   artifact existence, and declared presentation roots.
6. Report validation errors without changing the authoritative trace.

The view is disposable and regenerable. It never becomes execution state and
this skill does not render a graph or open a control application.
