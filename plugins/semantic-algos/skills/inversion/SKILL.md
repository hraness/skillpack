---
name: inversion
description: >-
  Explicitly invoked semantic inversion that derives safeguards by first
  asking how to guarantee failure. Use only when the user invokes $inversion.
  Do not use for repository, delivery, or operational changes.
---

# Inversion

Run only when explicitly invoked. Produce a semantic failure analysis, not an
action or code change.

1. State the desired outcome and its observable success condition.
2. Ask what would reliably guarantee failure.
3. Enumerate causal failure mechanisms rather than vague bad outcomes.
4. Rank them by likelihood, severity, and controllability.
5. Negate the strongest mechanisms into concrete safeguards.
6. Identify safeguards that conflict or introduce new failure modes.
7. Return the smallest set of guards that materially changes the risk.

Do not assume that avoiding failure guarantees success; name what remains
necessary but unproven.
