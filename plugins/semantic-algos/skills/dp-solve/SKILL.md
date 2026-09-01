---
name: dp-solve
description: >-
  Explicitly invoked semantic decomposition of a problem into overlapping
  subproblems whose answers can be reused and synthesized. Use only when the
  user invokes $dp-solve. This is a reasoning operator, not a request to write
  dynamic-programming code or perform repository delivery.
license: LicenseRef-Permission-Rob-Cheung
---

# DP Solve

Run only when explicitly invoked. Work on the supplied problem as semantic
text; do not inspect or change a codebase unless separately authorized outside
this skill.

1. Define the target state or answer and its boundaries.
2. Decompose it into subproblems.
3. Identify overlapping subproblems and the minimal state needed to answer
   each once.
4. Order dependencies and solve base cases first.
5. Record the reusable answers in a memo table.
6. Synthesize the target answer from the memoized results.
7. Check that no conclusion depends on an unstated subproblem.

Prefer a smaller reusable state graph to artificial formalism.
