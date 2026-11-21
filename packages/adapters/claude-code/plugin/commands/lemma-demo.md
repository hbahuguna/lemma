---
description: Run Lemma demo assessment (optional URL for live checks)
---

Run the Lemma demo assessment for: $ARGUMENTS

Behavior:
- First create and show the deterministic demo test plan with `lemma plan --target <TARGET_OR_URL> --intent "${intent}" --command demo`.
- If an `http(s)` URL is provided, run a **live browser** demo assessment with comprehensive browser defaults (no `--no-browser`).
- If no URL is provided, run a **static** demo assessment (`--no-browser`).
- Preserve explicit user flags/overrides and use shared command builders/catalog semantics.
- Final report must show the plan first, then each scenario's result from `test_plan`, then findings and gaps.

Reference invocations:
- Static (no URL): `lemma run --target . --no-browser --personas-dir "<personas-dir>" --intent "Lemma demo assessment"`
- Live (with URL): `lemma run --target https://example.test --personas-dir "<personas-dir>" --intent "Lemma demo assessment" --crawl ...` (target becomes provided URL; no `--no-browser`)

Intent: `Lemma demo assessment`  
Personas dir: `<personas-dir>`
