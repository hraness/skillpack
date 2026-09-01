---
name: assumption-audit
description: >-
  Explicitly invoked semantic audit of the load-bearing factual, causal,
  capability, people, continuity, and definitional assumptions in a claim or
  plan. Use only when the user invokes $assumption-audit. Do not route coding,
  repository review, delivery, or operations through this skill.
license: LicenseRef-Permission-Rob-Cheung
---

# Assumption Audit

Run only when explicitly invoked. Analyze only the supplied claim, plan, or
authorized text; do not inspect a repository or execute proposed tests.

1. Restate the claim or plan without strengthening it.
2. Extract its material factual, causal, people, continuity, capability, and
   definitional assumptions.
3. Rate each assumption by load, evidence-backed confidence, and testability.
4. Identify the keystone: highest load with weakest evidence.
5. Propose the cheapest decisive test for the keystone and the next two risks.
6. Explain the fallback shape if the keystone fails.

Return an assumption register, keystone, test agenda, and fallback. Do not pad
the register with low-load premises.
