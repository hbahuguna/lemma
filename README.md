# lemma

**Deterministic release confidence, shipped inside the agent you already use.**

`lemma` is the TypeScript successor to `assay` (`quality-harness`). It keeps the
same product promise — inspect a target, operate a live surface when a browser
is available, store hashed evidence, and emit an inspectable confidence score —
and packages it as a first-class plugin for every major coding agent.

## Why a rewrite

The Python core in `../assay` proved the model: five fixed phases, disjoint
specialist personas, hashed evidence, a deterministic score, and a kill switch
that fails closed. What it could not do cheaply was ship as one installable
artifact across OpenCode, Claude Code, Codex, Antigravity, and Cursor. Those
hosts extend the agent with TypeScript/JavaScript plugins, command packs, hooks,
skills, and MCP bridges.

`lemma` splits the product into a host-neutral core and thin adapters:

```text
lemma
├── packages/core        deterministic engine, static checks, evidence, scoring
├── packages/browser     optional Playwright Operate layer
├── packages/cli         machine-first `lemma` CLI (JSON stdout)
├── packages/agent       host-neutral agent loop, prompts, context protocol
├── packages/adapters    opencode | claude-code | codex | antigravity | cursor
├── packages/cloud       metering, auth, quota, ledger, signup, billing, queue
├── packages/personas    specialist contracts and ownership rules
└── schemas/             versioned report, state, evidence, and metering schemas
```

Dependency direction is one-way: `adapters -> agent -> core`. The core never
imports a host SDK, never reads an agent session, and never lets a model set the
score.

## What stays invariant

These are product law, carried over from `assay`:

1. Phase order is fixed: **Risk Analysis → Test Planning → Execution → Evidence
   Collection → Confidence Scoring**.
2. The orchestrator, not a model, owns ordering, budget, scoring, and the kill
   switch.
3. `lemma run` prints one JSON report to stdout; progress and warnings go to
   stderr.
4. State lives under `.lemma/`. Writes are atomic. A crash cannot leave a
   half-written progress file or a manifest that claims a missing artifact.
5. No evidence, no finding. Every finding points at an artifact under
   `.lemma/evidence/<run_id>/` with a SHA-256 hash in the manifest.
6. Redact before persistence. Credentials, cookies, auth headers, and private
   keys never reach state, evidence, logs, stdout, or a report.
7. Blocked, skipped, errored, or refused work is a coverage gap, never a pass.
8. A halted run stays halted. Nothing resumes it automatically.
9. Persona checks are disjoint. Zero owners or multiple owners is a
   configuration error.
10. An unverified plugin is a blocked check, never a pass and never a reason to
    fail the whole run.
11. No dashboard in the open-source core. Onboarding and usage APIs are allowed;
    a UI is a separate product decision.

## Status

**Pre-alpha. Design and migration planning only.** There is no runtime yet.
The work queue, acceptance criteria, and parity contract live in
[`BOARD.md`](./BOARD.md). The source-to-target mapping lives in
[`docs/parity/assay-feature-inventory.md`](./docs/parity/assay-feature-inventory.md).


## Host adapters and install (pre-alpha)

Implemented adapter packages and a machine-first installer exist for OpenCode,
Claude Code, Codex, Antigravity, and Cursor (`lemma install <host>`). Capability
declarations, degradation behavior, install layouts, and current verification
status are documented in [`docs/adapters.md`](./docs/adapters.md). Live host-runtime
integration and unverified host API surfaces remain provisional where noted.


## How to work the board

Read [`AGENTS.md`](./AGENTS.md) first. Then:

1. Pick the lowest-numbered `Ready` task whose dependencies are `Done`.
2. Move it to `In Progress` and state the acceptance test you will run.
3. Ship one story-scoped change with a test or verified artifact.
4. Move it to `Done` only when every acceptance criterion passes.
5. Put discovered work in the backlog as a new higher-numbered task.

## Repository layout (planned)

| Path | Responsibility |
| --- | --- |
| `packages/core` | Five-phase orchestrator, state, evidence, scoring, report, static checks |
| `packages/core/src/determinism` | Injectable clock and entropy providers |
| `packages/core/src/workflows` | Versioned workflow loader and phase-order validation |
| `packages/core/src/checks` | Check catalog, registry, and intent-linked planning |
| `packages/core/src/personas` | Frontmatter parsing, schema validation, ownership |
| `packages/core/src/static` | Source inventory, secret/unsafe/a11y scans, category scopes |
| `packages/core/src/evidence` | Hashed artifact store, manifest, signing, verification |
| `packages/core/src/scoring` | `weighted-coverage-v1` and gate policy |
| `packages/browser` | Optional Playwright Operate layer and capture |
| `packages/cli` | `lemma` command surface and exit codes |
| `packages/agent` | Host-neutral agent loop, context protocol, command catalog |
| `packages/adapters/opencode` | OpenCode plugin, commands, tools, forms |
| `packages/adapters/claude-code` | Claude Code plugin, commands, skills, hooks |
| `packages/adapters/codex` | Codex command and exec bridge |
| `packages/adapters/antigravity` | Antigravity integration |
| `packages/adapters/cursor` | Cursor rules, commands, MCP bridge |
| `packages/cloud` | Metering, auth, quota, ledger, signup, billing, queue, retention |
| `packages/personas` | Specialist Markdown contracts |
| `schemas/` | Normative JSON Schemas and compatibility fixtures |
| `docs/parity/` | Assay feature inventory and parity gates |

## Relationship to `assay`

`assay` remains the reference implementation and the parity oracle until
`LEM-139` signs off full feature parity. During migration:

- Every `assay` module, CLI command, plugin command, schema, persona, fixture,
  and test suite must map to a `lemma` task.
- `assay` behavior is the source of truth for scoring, phase order, evidence,
  redaction, and kill semantics.
- New `lemma` behavior that intentionally diverges gets an ADR and a board
  decision. Silent drift is a defect.
