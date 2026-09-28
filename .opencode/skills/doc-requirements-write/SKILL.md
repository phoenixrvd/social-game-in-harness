---
name: doc-requirements-write
description: "Requirements documentation guidance."
slash: true
metadata:
  opencode/autoinvoke: false
---

# Requirements Write

## Rules (BLOCKER)

- Use existing requirements and provided context as sources; do not invent facts.
- Reference only documents in `docs/` or external sources that are relevant to the requirement. Never reference volatile project files.
- Requirements describe WHAT, not HOW.
- Each requirement describes one verifiable need.
- Do not duplicate or partially repeat existing requirements.
- Record unclear information as an assumption or open question.
- Write all text in English.
- Use only these requirement states: `draft`, `defined`, `implemented`, `removed`, `rejected`.
- Change requirement documentation only.
- Write requirements to `docs/requirements/`.
- A Markdown file may contain multiple requirements only when they address the same topic or share the same context.
- Before creating requirement documents, ask the user which filename prefix to use.
- Name each file `<prefix><number>-<kebab-case-title>.md`, using the next available requirement number for that prefix. Do not assume `ofk-`.

## Template

Use [TEMPLATE.md](TEMPLATE.md) for each requirement file and preserve its structure strictly; missing sections = "None".
