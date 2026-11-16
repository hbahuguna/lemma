# Performance and Scale Budgets (LEM-131)

This document defines initial deterministic performance/scale budgets for the
lemma core engine. Budgets are enforced through regression tests that prioritize
correctness and bounded behavior at scale over wall-clock timing (to avoid
flaky, environment-dependent failures).

## Scope

Budgets apply to host-neutral core processing paths:

- **Scoring and report generation:** confidence scoring and report building over
  large synthetic run states must remain correct and schema-valid.
- **Evidence storage and verification:** hashed evidence recording, checkpoint/
  finalize, and verification must remain correct for larger artifact sets.
- **Bounded execution planning:** orchestrator/check budget controls must enforce
  configured limits (`maxChecks`) so planned work stays bounded.

## Budgets (initial)

| Area | Budget target | Enforcement |
| --- | --- | --- |
| Scoring/report scale | >= 1,000 checks and >= 400 findings processed into a valid confidence result and schema-valid report | `packages/core/test/performance-scale/performance-scale-budgets.test.ts` (correctness + validation; no strict wall-clock assertion) |
| Evidence scale | >= 250 text artifacts recorded with checkpoint/finalize and full verification passing (no tamper, no missing/mismatch) | Same test suite |
| Execution budget | Synthetic planning of 200 checks with `maxChecks=25` yields exactly 25 planned checks and bounded run completion | Same test suite |

## Notes

- Tests are deterministic (no network, no required wall-clock thresholds) and run
  in standard unit-test environments.
- Budgets may be tightened in future tasks with environment-aware benchmarks and
  CI evidence; any tightening must preserve deterministic pass/fail behavior.
