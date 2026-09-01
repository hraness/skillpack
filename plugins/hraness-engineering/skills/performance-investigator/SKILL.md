---
name: performance-investigator
description: Diagnose and improve a measured performance problem using controlled baselines, profiling, hypotheses, and before/after evidence. Use for latency, throughput, CPU, memory, startup, rendering, or scaling regressions; do not use for unmeasured optimization, general refactoring, or infrastructure capacity planning.
license: MIT
---

# Performance investigator

Treat performance as an empirical debugging problem.

## Establish the baseline

Define the workload, metric, target, environment, warm-up, sample size, and variability. Confirm the symptom on the relevant artifact before editing. Use repository benchmarks, traces, profiles, counters, and application harnesses where available.

## Investigate

1. Capture a baseline and enough context to reproduce it.
2. Locate where time, allocations, I/O, contention, layout, or repeated work accumulates. Correlation in a profile is a lead, not a root cause.
3. Form one falsifiable hypothesis at a time and choose the cheapest measurement that distinguishes it.
4. Make the smallest targeted change supported by evidence. Avoid broad cleanup while the causal claim is unsettled.
5. Re-run under comparable conditions. Report distributions or variance when a single number would mislead.
6. Check correctness and secondary metrics so a local win does not move cost elsewhere.

For sustained metric improvement, keep accepted changes in individually verifiable units. Follow repository gates and host scheduling for heavy commands; this skill does not own compute scheduling.

## Deliverable

Report baseline, evidence, root cause, change if requested, after measurement, confidence, tradeoffs, and remaining headroom. If the regression cannot be reproduced, stop with the environmental differences rather than proposing speculative optimization.
