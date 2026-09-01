---
name: assess-change-impact
description: Assess the direct and indirect blast radius of a proposed or existing code change, including callers, contracts, state, operations, and validation needs. Use when preparing to ship or when a small diff may have hidden effects; do not use to generate competing designs, explain an unchanged subsystem, or implement the change.
license: MIT
---

# Assess change impact

Determine what the change can affect beyond the edited lines and what evidence would make it safe to ship.

## Assessment

1. Name the changed contract: data shape, API, state transition, timing, side effect, configuration, or user-visible behavior.
2. Trace direct callers and consumers, then follow shared types, schemas, registries, persistence, caches, events, background work, and external boundaries.
3. Check compatibility across versions, migrations, feature gates, retries, cancellation, concurrency, security, observability, deployment order, and rollback where applicable.
4. Read existing tests and repository delivery rules. Identify which current checks cover the risk and which claims remain unproven.
5. Prove the highest-value safety claim with read-only or existing runnable behavior when practical. Do not assert safety from compilation alone.

Avoid generic risk inventories. Exclude categories that cannot be reached and say why.

## Deliverable

Return:

- Change contract and scope.
- Impacted consumers grouped as direct, indirect, operational, or external.
- Failure modes with likelihood or confidence.
- Required validation and sequencing.
- Explicit unaffected areas backed by evidence.
- Open gaps that prevent a confident verdict.
