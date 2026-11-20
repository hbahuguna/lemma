---
name: lemma
description: Deterministic, evidence-backed release confidence assessments via Lemma CLI/agent workflows.
---

# Lemma skill

Use Lemma to run deterministic, evidence-backed quality/release assessments. The harness owns phase ordering, execution, evidence, and scoring; agents/adapters must not invent findings, scores, or decisions.

## Commands and modes
- Primary CLI: `lemma` (JSON report to stdout for `run`; progress/warnings to stderr).
- Personas dir (configurable): `<personas-dir>`.
- Catalog assessments: 60 Lemma commands.
  - `lemma-browser`: live browser assessment, requires `http(s)` URL.
  - `lemma-demo`: static when no URL, live browser when URL provided.
  - Other catalog commands: static intent-driven runs (`Lemma <label> assessment`).
- Operational commands include status/report/abort/verify-evidence and other management surfaces as available.

## Safety and invariants
- Deterministic harness owns execution, evidence, and scoring (fixed phases: Risk Analysis → Test Planning → Execution → Evidence Collection → Confidence Scoring).
- Blocked/skipped/errored/refused checks are coverage gaps (never pass, never raise confidence).
- Evidence must be hashed and attributable; do not claim unobserved behavior.
- Never ask for, echo, or persist raw secrets/tokens/credentials; use secure env/secret references and redaction.
- Bounded agent behavior: no repeated commands, respect allowlists/caps, report run IDs, executed work, gaps/limitations, and concrete fixes.
