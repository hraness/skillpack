---
name: create-app-verifier
description: Create and prove a new project-local application-verifier Agent Skill that launches, health-checks, drives, observes, and safely cleans up the real application with a user-facing feature map. Use when a repository lacks an application verifier; do not use to maintain an existing verifier, write ordinary tests, or repair product behavior.
license: MIT
---

# Create an application verifier

Create a reusable project-local skill that lets a later agent drive the real application through supported user paths and capture skeptical-reviewer evidence.

Read [references/generated-verifier-contract.md](references/generated-verifier-contract.md) before generating files.

## Discover

Interview the repository before asking the user. Determine the primary user surface, documented launch command, readiness signal, existing harnesses, stable interaction handles, observable effects, and isolation capabilities. Prefer repository-owned Playwright, CDP, accessibility, PTY, HTTP, simulator, or CLI surfaces over a new driver.

Do not modify product code or repair a broken environment unless the user also asked for that work. Report a blocker rather than teaching false steps.

## Generate

Use the repository's existing project skill root or `.agents/skills/` when none exists. Create `verify-<app>/` with:

- `SKILL.md` containing Doctor, Launch, Drive, Evidence, Cleanup, and Feature Map sections.
- `agents/openai.yaml` with matching UI metadata.
- `references/features/README.md` plus one concise file per initially mapped user-facing feature.
- `scripts/` only for a driver or helper that materially improves reproducibility.

Use a unique run identifier, loopback-only ports, disposable data directories, and synthetic or explicitly provisioned test accounts. Never clone a person's browser or application profile, reuse production cookies or tokens, point destructive flows at production, or drive a shared instance unless the verifier explicitly proves that is safe.

## Prove

Execute the generated instructions once against one mapped feature: doctor, launch, drive the real user path, capture the action and stable result, verify a side effect when applicable, and clean up. Confirm evidence survives cleanup and the launched process and disposable state do not.

If this cannot be completed, label the verifier as a draft and report the exact failed invariant. Do not claim that an unexecuted harness works.
