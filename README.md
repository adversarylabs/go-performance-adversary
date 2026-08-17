# Go Performance adversary

Reviews Go for resource amplification, defer-in-loop, per-request clients, hot-path regexp compilation, and quadratic string building.

## Goals

The adversary is designed to produce a small number of high-confidence,
actionable findings grounded in concrete repository evidence. Its review should
be deterministic where possible, explicit about impact, and quiet when the
available evidence does not justify a finding.

## Scope

It evaluates changed Go code for high-confidence allocation, caching, compilation, copying, buffering, and hot-path performance hazards.

The complete detector or review inventory is maintained in
[CHECKS.md](CHECKS.md).

## Boundaries

It owns only this Go specialty. Other Go concerns remain with the corresponding `go/*` adversaries, and it does not execute or modify the target repository.
