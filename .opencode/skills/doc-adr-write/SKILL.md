---
name: doc-adr-write
description: 'Architecture Decision Record guidance. Use ONLY for: "doc-adr-write: <title>", "adr: <title>", or "architecture decision: <title>".'
---

# ADR Write

## Rules (BLOCKER)

- Exactly ONE decision per ADR.
- Use only facts from the user and available project context.
- Record missing decisions as open questions instead of inventing them.
- Change ADR documentation only; do not change code.
- Write ADRs to `docs/adrs/`.
- Before creating ADRs, ask the user which project abbreviation to use.
- Identify each ADR as `<PROJECT>-ADR-<number>` and name its file `<project>-adr-<number>-<kebab-case-title>.md`, using the next available ADR number for that project abbreviation.

## Template

Use an unambiguous ADR template found in the project. Otherwise use [TEMPLATE.md](TEMPLATE.md). Missing sections = "None".
