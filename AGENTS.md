# AGENTS.md

## Purpose

This repository contains an official domain-level Go adversary. It should behave like a staff Go engineer reviewing prepared evidence, not like a broad style linter.

## Design principles

- Consume prepared runtime evidence when ReviewContext capabilities are available.
- Treat the current discovery and parser layer as transitional runtime compatibility.
- Keep the domain bounded and prefer a few high-confidence, operational findings.
- Use deterministic analysis to prepare facts and review synthesis to explain engineering impact.
- Group evidence that shares one remediation.
- Point every finding to concrete changed source evidence.
- Never execute, install dependencies in, or modify the scanned repository.
- Keep benchmark source external; the corpus is calibration metadata only.

## Testing

- Add a focused regression fixture for every signal and clean counterexamples.
- Preserve the five graded fixture tiers and expected review snapshots.
- Keep automatic detection and artifact-isolation tests passing.
- Run `npm test`, `adversary validate .`, and `adversary pack --check .`.
