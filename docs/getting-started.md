# Getting started

This guide shows a practical local workflow for running lemma, inspecting results,
and installing host integration assets. For deeper behavior/contracts, see
[`docs/cli-and-agent.md`](./cli-and-agent.md) and [`docs/adapters.md`](./adapters.md).

## Prerequisites

- Node.js **20+** (Node 22 recommended)
- `pnpm` (workspace `packageManager` pinned in `package.json`)
- Git (recommended for repository inventory/scoping behavior)

## Build the workspace

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

You can invoke the CLI directly from the built package during local development:

```bash
node packages/cli/dist/cli.js --help
```

## Run an assessment

`lemma run` executes the release-confidence workflow and emits a single JSON
report to **stdout**. Progress and warnings are written to **stderr**.

```bash
mkdir -p .lemma
node packages/cli/dist/cli.js run --target . --intent "release confidence" > .lemma/report.json
```

Common options (as implemented): `--root`, `--intent`, `--max-checks`,
`--resume`, `--seed`, `--clock-mode`, `--frozen-clock`, `--output`, `--quiet`,
`--keep-runs`, `--fail-on`, `--min-score`.

## Inspect results

```bash
# Latest persisted run state / history summary
node packages/cli/dist/cli.js status

# Latest saved report (JSON)
node packages/cli/dist/cli.js report
```

State and evidence are stored under `.lemma/` (atomic writes). Evidence artifacts
for a run live under `.lemma/evidence/<run_id>/` and can be verified with:

```bash
node packages/cli/dist/cli.js verify-evidence --run-id <run_id>
```

## Manage runs and artifacts

```bash
# Request a manual kill/abort for the current run
node packages/cli/dist/cli.js abort

# Prune historical runs/evidence
node packages/cli/dist/cli.js prune --keep-runs 10
```

Additional implemented command families include exports (`sarif`, `junit`),
report signing/verification (`sign-report`, `verify-report`), calibration,
persona tooling, and suppressions. Use `lemma <command> --help` (where supported)
or top-level help for current flags.

## Install host adapter assets

Generate deterministic host integration assets for a supported host:

```bash
node packages/cli/dist/cli.js install opencode --dir .
# hosts: opencode | claude-code | codex | antigravity | cursor
```

Flags:
- `--dir <path>` / `--root <path>`: target project directory
- `--dry-run`: show planned writes without modifying files
- `--force`: overwrite existing generated files

See [`docs/adapters.md`](./adapters.md) for compatibility, install layouts, and
capability-honest/provisional host status.

## CI and containers

- PR automation and a marker-based PR comment action: `.github/workflows/pr.yml`,
  `.github/actions/quality-harness/`
- Core/container images:
  - `docker build -f Dockerfile -t lemma-core .`
  - `docker build -f Dockerfile.browser -t lemma-browser .`

## Notes on guarantees

- `lemma run` output contract is machine-first: JSON report on stdout, progress
  on stderr.
- Blocked/skipped/errored/refused work is a coverage gap, not a pass.
- Halted runs remain halted and hold; no automatic resume.
- Host capabilities may be provisional/unverified in some environments and must
  degrade honestly (no silent emulation).
