---
name: code-review
description: 'Code review guidance. Use ONLY for: "code-review: <file>", "review-code: <file>", or "review: <file>".'
---

# Code Review

## Rules (BLOCKER)

- Review the requested files, diff, or change set and use project guidelines when available.
- Report only concrete bugs, risks, regressions, guideline violations, or relevant missing tests.
- Every finding needs a traceable `file:line` location and a clear impact.
- Do not speculate, duplicate findings, or report style preferences without a project rule.

## Findings

- Report findings ordered by severity as `[BLOCKER]` or `[WARNING]` with `file:line`, problem, and impact.
- Use `[BLOCKER]` only when the issue prevents safe use; use `[WARNING]` for other material issues.
- If there are no findings, report `No findings.`
