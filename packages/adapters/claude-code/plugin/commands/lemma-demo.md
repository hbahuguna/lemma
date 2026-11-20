---
description: Run Lemma demo assessment (optional URL for live checks)
---

Run the Lemma demo assessment for: $ARGUMENTS

Behavior:
- If an `http(s)` URL is provided, run a **live browser** demo assessment with comprehensive browser defaults (no `--no-browser`).
- If no URL is provided, run a **static** demo assessment (`--no-browser`).
- Preserve explicit user flags/overrides and use shared command builders/catalog semantics.

Reference invocations:
- Static (no URL): `lemma run --target . --no-browser --personas-dir "<personas-dir>" --intent "Lemma demo assessment"`
- Live (with URL): `lemma run --target https://example.test --personas-dir "<personas-dir>" --intent "Lemma demo assessment" --crawl ...` (target becomes provided URL; no `--no-browser`)

Intent: `Lemma demo assessment`  
Personas dir: `<personas-dir>`
