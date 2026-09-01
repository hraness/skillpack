---
name: analogy-transfer
description: >-
  Explicitly invoked semantic transform that imports mechanisms from
  structurally similar domains and checks where each analogy breaks. Use only
  when the user invokes $analogy-transfer. Do not use for ordinary repository
  analysis, coding, delivery, or orchestration.
license: LicenseRef-Permission-Rob-Cheung
---

# Analogy Transfer

Run only when explicitly invoked. Transform the supplied question or text; do
not inspect or mutate a repository, perform external actions, or treat an
analogy as evidence.

1. State the concrete problem.
2. Abstract its deep structure: flows, constraints, incentives, feedback,
   adversaries, scarcity, and stopping conditions.
3. Find three to five structurally similar domains, including one distant
   domain.
4. Name the mechanism each domain uses.
5. Translate the strongest mechanisms back into concrete candidate moves.
6. For every candidate, state the disanalogy and whether it breaks the transfer.
7. Return the strongest surviving transfer and the cheapest semantic or real
   test the user could choose to run separately.

Stop when additional domains repeat mechanisms already represented.
