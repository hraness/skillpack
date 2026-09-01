---
name: n-whys
description: >-
  Explicitly invoked why-chain exactly n levels deep across causal,
  conceptual, motivational, or philosophical explanations. Use only when the
  user invokes $n-whys; depth 5 replaces the former five-whys preset. Do not
  use for repository root-cause debugging, coding, delivery, or operations.
license: LicenseRef-Permission-Rob-Cheung
---

# N Whys

Run only when explicitly invoked. Analyze the supplied question without
inspecting a repository or acting on the result.

Accept an explicit positive depth `n`. If the user invokes `$n-whys` without a
depth, ask for one or use 5 only when they explicitly request the conventional
five-whys preset.

For each level:

1. Restate the current claim precisely.
2. Ask why it holds at the next explanatory layer.
3. Answer with one defensible link and name any shift between causal,
   historical, functional, motivational, or conceptual explanation.
4. Preserve uncertainty and branching rather than inventing a single root.

Return exactly `n` numbered links plus a short note on the deepest claim's
evidence and alternative branches. Stop early only when the chain cannot
continue honestly, and state why.
