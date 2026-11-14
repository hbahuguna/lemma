# Assay ↔ Lemma parity harness

`pnpm test:parity` compares the Python `assay` oracle and the TypeScript `lemma`
implementation on the same fixture and options.

- Oracle pin: `docs/parity/oracle.json` (commit, python, fixture, deterministic seed/clock).
- Baselines: `docs/parity/baselines/{completed,halted,browser-blocked}.json` (normalized oracle reports).
- Harness: `scripts/parity/harness.mjs`

## Normalization (documented volatile fields)

Normalization removes only fields that are expected to vary without semantic
change: run/timing identifiers and timestamps, absolute/host-specific paths and
separators, evidence artifact paths/hashes and per-artifact location metadata,
and environment-specific directory roots. It **never** hides or alters:
`status`, `decision`, `confidence.score/band/breakdown/penalties`, `coverage`
and coverage counts, findings (severity/status/check/category/domain/title/
fingerprint and finding counts), check outcomes/ids/weights/domains/kinds,
blockers and blocker reasons/checks/personas, workflow phases, schema contract,
or `halted_reason`.

## Usage

- `pnpm test:parity` — verify oracle matches committed baselines, verify a
  seeded/frozen pair produces zero diff, run normalization/diff self-checks, and
  compare lemma output when `LEMMA_PARITY_CMD` is set.
- `node scripts/parity/harness.mjs --write-baselines` — regenerate committed
  baselines from the pinned oracle (requires `../assay` at pinned commit).

## Lemma integration

When the lemma runner is implemented, set `LEMMA_PARITY_CMD` to a command that
prints one JSON report to stdout for scenario `LEMMA_PARITY_SCENARIO`
(`completed|halted|browser-blocked`) using options from `LEMMA_PARITY_ORACLE`.
The harness normalizes and field-diffs lemma output against baselines and exits
nonzero on drift.
