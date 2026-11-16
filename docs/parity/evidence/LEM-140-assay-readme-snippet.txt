# quality-harness

`quality-harness` is a deterministic, risk-based testing harness for release
decisions. It inspects a source tree, operates a live target when a browser is
available, stores hashed evidence, and emits a machine-readable confidence score
with findings.

It is not a bug oracle and not a probability that the release has zero defects.
The score is scoped engineering judgment: it states what was executed, what was
not, and which findings still block an advisory ship decision.

## Why this shape

The harness follows five fixed phases:

```text
Risk Analysis -> Test Planning -> Execution -> Evidence Collection -> Confidence Scoring
```

Every phase writes durable state to `.harness/`. The orchestrator, not a model,
decides check order, budget, scoring, and whether the kill switch fires. Three
specialist personas own disjoint checks and declare their tools, output schema,
blocker schema, and refusal rules in `personas/`.

## Requirements

- Python 3.8 or newer. This repository is developed and tested with Python 3.11.
- No runtime dependencies for static inspection.
- Playwright is optional and only needed for the live Operate layer.

## Quick start

```bash
# Static Inspect run against the intentionally imperfect fixture.
python -m harness run \
  --target examples/sample-repo \
  --no-browser \
  --root .harness-demo \
  --personas-dir personas

