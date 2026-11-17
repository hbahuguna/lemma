# `.lemma/` project state layout

`lemma` stores durable run and workflow state under `.lemma/` in the target workspace root. Reads and writes go through shared primitives in `@lemma/core/state` (atomic writes, safe reads, directory creation, file locks). Packages must not reimplement these primitives.

## Subdirectories and files

| Path | Purpose |
| --- | --- |
| `state/` | Current and per-run orchestrator state (progress, manifests, persisted run state). Existing core run state location. |
| `evidence/` | Evidence artifacts and manifests for runs (hashed/redacted evidence under run-scoped paths). |
| `events.jsonl` | Append-only run/event stream (existing). |
| `history.json` | Historical run/report index and summaries (existing). |
| `framework/` | Durable project/framework configuration and derived framework state. |
| `learning/` | Durable learning artifacts and adaptation state. |
| `recordings/` | Captured recordings and replay inputs. |
| `tests/` | Durable/generated/upgraded test intents and suites (e.g. `.lemma/tests/generated/`, `.lemma/tests/upgraded/`, suites). |
| `auto/` | Auto-loop workflow state and per-cycle evidence (`.lemma/auto/<run_id>/...`). |
| `continuous/` | Continuous workflow durable history by trigger (`.lemma/continuous/pr|nightly|scheduled/`). |
| `regressions/` | Regression lifecycle records and audit logs (`.lemma/regressions/<id>.json`, events). |
| `humans/` | Human decision/context records (e.g. `decision-context.json`). |
| `confidence/` | Confidence-engineering workspace linkage/state (complements `.confidence/` workspace when present). |
| `incidents/` | Incident records, preserved traces/evidence links, and incident reports. |

## Guarantees

- **Atomic writes:** JSON/file updates use `atomicWriteJson` / `atomicWriteFile` from `@lemma/core/state`.
- **Corruption handling:** Corrupt JSON/state is reported as a typed error (`CorruptStateError`/`StateError`) and preserved on disk for inspection. Validation and prune operations never silently delete corrupt state.
- **Layout validation:** `ProjectState.validateLayout()` / `lemma doctor` report missing or corrupt directories/files as typed validation errors without mutating preserved state.

## Programmatic API

`@lemma/core` exports `ProjectState` (see `packages/core/src/project-state.ts`) to create, read, validate, and prune layout-managed entries using shared state primitives.
