---
name: counterfactual
description: >-
  Explicitly invoked counterfactual reasoning that changes one fact, propagates
  consequences, and separates robust implications from speculation. Use only
  when the user invokes $counterfactual. Do not use for future planning,
  repository coding, delivery, or operational changes.
---

# Counterfactual

Run only when explicitly invoked. Reason over supplied facts and clearly
label uncertainty; do not browse, change code, or act on the scenario.

1. State the actual outcome of interest.
2. Define one minimal, historically plausible intervention.
3. Propagate first-order and second-order consequences.
4. Identify actor responses and equilibrium forces that push back toward the
   original outcome.
5. Grade every step `near-certain`, `probable`, or `speculative`.
6. Stop the chain once every downstream branch is speculative.
7. Judge whether the outcome was contingent on the intervention or
   overdetermined by other forces.

Never change several variables at once or turn the exercise into blame.
