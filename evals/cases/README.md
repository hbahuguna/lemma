# Model evaluation cases (LEM-163)

Versioned evaluation case fixtures loaded by `runModelEval`.

- Location: `evals/cases/*.json` (and subdirectories such as `evals/cases/sample/`).
- Shape: `{ "id", "description", "input", "expected_business_behavior", "reviewed" }`
- Cases with `reviewed: false` are skipped with an explicit note (not silently included).
- Outcomes: `PASS`, `FAIL`, `REGRESSION` (was `PASS` in recorded baseline, now `FAIL`), `IMPROVEMENT`, `UNCHANGED`, `UNEVALUATED`.
- Evidence is recorded per case under `.lemma/evidence/<run_id>/eval/<case_id>/` with redaction before persistence.
