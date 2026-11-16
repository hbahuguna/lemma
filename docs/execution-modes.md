# Execution Modes (LEM-186)

`lemma` runs operate in one explicit execution mode, chosen before the run and
recorded in progress/report. A mode cannot be silently changed mid-run and
resume enforces the same mode.

## Modes and evidence semantics

- **`plan`** — Produces planned tests/checks only. No execution findings are
  produced; evidence consists of the recorded plan/scope and rationale.
- **`test`** — Executes planned tests/checks and records execution evidence and
  findings according to normal harness semantics.
- **`review`** — Executes independent review (LEM-179). Evidence is the review
  artifacts/notes tied to the run; it does not substitute for executed test
  evidence.
- **`focused`** — Runs a bounded subset (explicit scope/cut). Evidence is valid
  only for the executed subset and must record what was out of scope.
- **`learn`** — Runs exploration/learning without producing final findings.
  Outputs are exploratory observations/evidence, not promotable final findings.

## Recording and enforcement

- Mode is recorded in run progress state (`mode`) and final report
  (`execution_mode` / mode metadata).
- Resume enforces the same mode. Attempting to resume with a different mode is a
  typed `ModeMismatchError` (invalid mode transition).
- Missing mode defaults to `test` for backward compatibility with existing runs,
  but new explicit mode-aware runs should set `mode`.
