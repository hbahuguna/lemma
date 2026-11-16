# Run Sizes (LEM-187)

`lemma` runs can be scaled by **run size**: `quick`, `medium`, or `large`. The
size is chosen before a run, recorded in run state/report, and cannot be silently
shrunk or grown. Resume enforces the same size.

## Perspective counts (enforced)

| Size   | Perspectives |
|--------|--------------|
| quick  | 2            |
| medium | 4            |
| large  | 6            |

The perspective count is recorded in the run (`run_size`, `perspectives_count`)
and enforced by size-aware planning.

## Cut lines and evidence expectations

Cut lines define which check families are in scope per size. Out-of-scope checks
are **not silently skipped**; they are reported as explicit coverage notes.

- **quick (2 perspectives):** Focused, highest-signal checks only.
  - In scope: core/critical functional, security, and reliability checks tied to
    the declared intent/risks.
  - Out of scope (explicit coverage note): extended compatibility, deep
    exploratory/browser matrices, non-critical integrations, and exhaustive
    domain sweeps. Evidence is sufficient for a fast signal, not full coverage.
- **medium (4 perspectives):** Balanced coverage across primary domains.
  - In scope: core functional/security/reliability plus key UX/accessibility,
    API/data, and integration checks relevant to intent/risks.
  - Out of scope (explicit coverage note): exhaustive long-tail matrices, heavy
    load/stress campaigns, and broad exploratory sweeps beyond prioritized
    domains. Evidence supports standard release confidence with documented gaps.
- **large (6 perspectives):** Broad, multi-domain coverage.
  - In scope: comprehensive checks across functional, security, reliability,
    accessibility/UX, API/data, compatibility/integrations, and risk-driven
    exploratory families within budget.
  - Out of scope (explicit coverage note): only checks excluded by explicit
    policy/budget/capability constraints; exclusions are recorded as coverage
    notes with rationale. Evidence aims for maximal in-scope confidence.

## Recording and enforcement

- Chosen size and perspective count are recorded in run progress state and final
  report.
- Resume enforces the same size (no silent shrink/grow).
- Size-aware planning emits explicit coverage notes for out-of-scope check
  families instead of silently skipping them.
