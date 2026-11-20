---
description: Run Lemma api assessment
---

Run a Lemma **api** assessment for: $ARGUMENTS

## Goal
- Produce a useful, evidence-backed assessment for this intent. Do **not** rely on a generic `lemma run --intent "Lemma api assessment"` if it produces 0 checks/evidence ("No handler registered"/unscored); perform direct analysis and collect evidence instead, and report limitations honestly.
- No secrets/tokens/credentials. Coverage gaps (blocked/skipped/errored/unavailable/refused) never pass and never inflate confidence.

## Steps
1. **Identify target/context**: parse `$ARGUMENTS` for URL(s), paths, scope, and goals. If a reachable `http(s)` URL is provided and relevant, treat it as a live target and also inspect local source in the current workspace.
2. **Collect live/browser evidence when applicable** (for web/UI or runtime-observable concerns): run
   ```bash
   lemma browser <URL>
   ```
   from the target workspace in a **headed/visible browser** (never `--headless`, never `--no-browser`; requires Chrome/Chromium). Record command, run ID, status, and evidence paths. If blocked/unavailable, report as a coverage gap.
3. **Inspect project source/config/artifacts** relevant to **api**: use available tools to read and search code, configs, tests, CI, docs, and existing `.lemma/` reports/evidence. Ground observations in cited files/paths (and lines/snippets where useful).
4. **Assess and report**: provide a structured assessment covering findings/issues (severity, impact, location/evidence, recommendation, verification), positive signals, and explicit coverage gaps/limitations. Tailor analysis to the **api** intent based on what can be observed.
5. **Optional CLI status** (if prior runs exist):
   ```bash
   lemma status --root .
   lemma report --root .
   ```
   Use these to reference existing evidence; do not claim execution that did not occur.

## Notes
- Personas dir (if needed): `<personas-dir>`
- Do not invent findings, scores, decisions, or evidence. Prefer concrete, reproducible observations and clearly mark anything not executed/observable as a coverage gap.
