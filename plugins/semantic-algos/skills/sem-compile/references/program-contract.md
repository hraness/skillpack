# Sem program contract

Sem is interpreted prose. Familiar forms such as pipelines, fan-out, mapping,
bindings, local operators, and bounded iteration are aids to understanding, not
a grammar.

A complete program makes these facts recoverable:

1. source values and authorized text inputs;
2. every semantic function application;
3. each application's declared input and local configuration;
4. dependencies and independent branches;
5. bounded iteration and semantic stopping tests;
6. failure behavior;
7. visible terminal artifacts and presentation order.

Use folder slugs as standard-library identities. Never select an operator from
its name alone. A local operator must declare its purpose, accepted input,
defining semantic moves, standalone return, stopping rule, and guardrails.

Semantic judgments such as selection, critique, synthesis, or a meaning-based
stopping test are applications and must be explicit. Structural file linking,
literal projection, or presentation order are not applications unless they
require judgment.

`compile-notes.md` records source mode, selected operators and why they fit,
local operators, application count, inferred constraints, unresolved
ambiguities, and `ready` or `blocked` status. Compilation never performs the
semantic work.
