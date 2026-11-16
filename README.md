# lemma

**Deterministic release confidence, shipped as a machine-first CLI, host-neutral agent core, and thin host adapters.**

`lemma` is the TypeScript successor to `assay` (`quality-harness`). It preserves
the core product contract: run a fixed five-phase assessment, collect hashed and
inspectable evidence, and emit an explainable confidence score and release
decision. A model may assist the agent loop, but the orchestrator owns phase
order, planning/budget, scoring, and the kill switch.

> **Status:** pre-alpha. Core CLI/runtime, adapter packages, installer assets,
> CI workflows, and container images exist in this repository. Some host runtime
> integrations/APIs (notably Codex/Antigravity/Cursor and specific
> form/session/background surfaces) remain provisional/unverified and must be
> treated as capability-honest limitations.

## Core invariants

These invariants are product law (see [`AGENTS.md`](./AGENTS.md)):

1. Phase order is fixed: **Risk Analysis → Test Planning → Execution → Evidence
   Collection → Confidence Scoring**.
2. The orchestrator/core owns ordering, budget, scoring, and the kill switch.
3. `lemma run` prints one JSON report to **stdout**; progress and warnings go to
   **stderr**.
4. State lives under `.lemma/`. Writes are atomic.
5. No evidence, no finding. Evidence artifacts are tracked/hashed in manifests.
6. Redaction happens before persistence (secrets/tokens must not leak into
   state, evidence, logs, stdout, or reports).
7. Blocked, skipped, errored, or refused work is a coverage gap (never a pass).
8. A halted run stays halted and forces a `hold` decision.
9. Persona checks are disjoint; invalid/unverified plugin conditions are never
   treated as passes.

## Quick start

### Prerequisites

- Node.js **20+** (Node 22 recommended; matches CI/container build baseline)
- `pnpm` (workspace uses a pinned `packageManager`)

### Build from source

```bash
pnpm install --frozen-lockfile
pnpm build
```

Run the CLI from the workspace build:

```bash
node packages/cli/dist/cli.js --help
```

### Run an assessment

```bash
# JSON report to stdout, progress/warnings to stderr
node packages/cli/dist/cli.js run --target . --intent "release confidence" > .lemma/report.json

# Inspect latest run state/report
node packages/cli/dist/cli.js status
node packages/cli/dist/cli.js report
```

Useful lifecycle commands:

```bash
node packages/cli/dist/cli.js abort
node packages/cli/dist/cli.js prune --keep-runs 10
```

> Notes: `lemma run` requires `--target`. Additional flags (e.g. `--root`,
> `--intent`, `--max-checks`, `--resume`, `--seed`, `--clock-mode`,
> `--frozen-clock`, `--output`, `--quiet`, `--keep-runs`, `--fail-on`,
> `--min-score`) are supported as implemented by the CLI/core; use command help
> for the current surface in your build.

## CLI usage

The CLI is machine-first (JSON-oriented stdout, diagnostics/progress to stderr).
Top-level commands available in this build include:

| Command | Purpose |
| --- | --- |
| `run` | Run the release-confidence workflow and emit report JSON |
| `status` | Print persisted run state/history summary |
| `report` | Print the latest saved report |
| `abort` | Request a manual kill of the current run |
| `prune` | Prune historical runs/evidence |
| `install` | Install host integration assets for a supported host |
| `personas` | List/lint/scaffold persona contracts |
| `sarif` / `junit` | Export report artifacts |
| `sign-report` / `verify-report` | Report signing/verification |
| `verify-evidence` | Verify evidence manifest/artifacts for a run |
| `suppress` / `suppressions` | Manage finding suppressions |
| `calibrate` | Run calibration fixtures and emit a report |

See [`docs/cli-and-agent.md`](./docs/cli-and-agent.md) for CLI behavior
contracts, agent loop/context/catalog semantics, and implementation pointers.

## State, evidence, and reports

- **State root:** `.lemma/` (atomic progress/events/history primitives)
- **Evidence:** per-run artifacts under `.lemma/evidence/<run_id>/` with hashed
  manifests and verification support (`verify-evidence`)
- **Report contract:** machine-readable JSON report emitted by `lemma run`
  (schema/contract coverage in `schemas/` and core report builders/validation)
- **Decision semantics:** completed runs produce inspectable confidence/decision
  data; halted/failed/coverage-gapped conditions are represented honestly
  (coverage gaps never become passes, halted runs hold)

## Host adapters

Implemented host adapter packages and a deterministic installer exist for:

`opencode`, `claude-code`, `codex`, `antigravity`, `cursor`

Install host assets into a project:

```bash
lemma install <host> [--dir <project>] [--dry-run] [--force]
```

Capability declarations, degradation behavior, install layouts, and verification
status (including provisional/unverified host API surfaces) are documented in
[`docs/adapters.md`](./docs/adapters.md).

## CI and automation

- **CI matrix and checks:** `.github/workflows/ci.yml` (core verify matrix across
  Node 20/22 and macOS/Linux/Windows, parity job, and browser blocked/enabled legs)
- **Provenance-ready release workflows:** `.github/workflows/release-dry-run.yml`
  and `.github/workflows/release.yml` (npm publish with provenance configured;
  real registry publish requires credentials/org setup)
- **PR automation:** `.github/workflows/pr.yml` with the composite action in
  `.github/actions/quality-harness/` to run lemma and maintain a single
  marker-based PR comment (`<!-- lemma-pr-comment -->`) in fork-safe contexts

## Container images

Container builds are provided for local/containerized CLI usage:

```bash
docker build -f Dockerfile -t lemma-core .
docker run --rm lemma-core --help

docker build -f Dockerfile.browser -t lemma-browser .
docker run --rm lemma-browser --help
```

- `Dockerfile`: core CLI image (Node 22, pnpm build, `lemma` entrypoint)
- `Dockerfile.browser`: browser-enabled image (Playwright/Chromium runtime + CLI)

## Documentation

- Getting started: [`docs/getting-started.md`](./docs/getting-started.md)
- CLI and agent behavior: [`docs/cli-and-agent.md`](./docs/cli-and-agent.md)
- Adapter compatibility and install: [`docs/adapters.md`](./docs/adapters.md)
- Architecture: [`docs/architecture.md`](./docs/architecture.md)
- Work queue and decisions: [`BOARD.md`](./BOARD.md)
- Parity mapping/evidence: [`docs/parity/assay-feature-inventory.md`](./docs/parity/assay-feature-inventory.md)
- Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md)

## Relationship to `assay`

`assay` remains the behavioral/parity oracle until full parity is signed off in
`LEM-139`. Intentional divergences (TypeScript/ESM, in-process engine, `.lemma/`
state root, host adapter model, etc.) must be documented via ADRs and the board
decision log rather than silent drift.
