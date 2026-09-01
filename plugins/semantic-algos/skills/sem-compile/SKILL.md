---
name: sem-compile
description: >-
  Explicitly invoked compiler from a natural-language request, loose semantic
  pipeline, or existing program.md into an inspectable Sem program without
  executing it. Use only when the user invokes $sem-compile. Do not use it for
  repository coding, delivery, orchestration, shell, messaging, or other
  external effects.
license: LicenseRef-Permission-Rob-Cheung
---

# Sem Compile

Run only when explicitly invoked. Sem is executable prose for composing
semantic functions; it is not parsed code, a hidden runtime, or authorization
for external effects.

Read [references/program-contract.md](references/program-contract.md) before
compiling.

1. Capture the request and only explicitly authorized text inputs.
2. Resolve candidate operators by reading their complete `SKILL.md` contracts;
   reading a contract does not invoke it.
3. Use a standard-library operator only when its input, procedure, output, and
   stopping rule fit. Define a bounded program-local operator otherwise.
4. Make every semantic application, dependency, independent branch, iteration
   bound, semantic choice, visible result, and return order recoverable.
5. Write a collision-safe `sem-programs/<title>/<timestamp>/` bundle containing
   `request.md`, `program.md`, and `compile-notes.md`.
6. Mark the bundle `ready` only when a fresh reader could execute it without
   the conversation; otherwise record exact blockers.

Do not apply any operator, answer the source request, browse, mutate a
repository, or create shell/code tasks. Stop after compilation.
