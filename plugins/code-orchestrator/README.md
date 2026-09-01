# Code Orchestrator

Portable Agent Skills for preparing and executing dependency-ordered,
multi-phase repository work.

This plugin exposes exactly two skills:

- `write-phase-plan` writes a context-complete plan with explicit ownership,
  acceptance criteria, dependencies, and validation.
- `phase-orchestrator` executes such a plan with bounded implementation and
  independent review workers.

Worker protocols are references of `phase-orchestrator`, not discoverable
skills. This prevents implementation and review roles from competing with the
parent workflow during routing.

The plugin coordinates reasoning and ownership only. It never replaces the
target repository's `AGENTS.md`, validation commands, CI, merge or release
policy, or the HRA host scheduler.

See [PROVENANCE.md](PROVENANCE.md) for attribution and pinned sources.
