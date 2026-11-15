# Assay → Lemma feature inventory

Source of truth: `/Users/skaparwan/github/assay` at commit
`assay@HEAD` (2026-11-14). This inventory is the completeness contract for the
migration. **Every row must map to a lemma task, and every task must update its
rows with evidence before it is marked Done.**

Machine-readable companion: `docs/parity/assay.manifest.json` (created by
`LEM-002`). `LEM-139` fails if any manifest entry has no owner task or verified
artifact.

Legend: `Pri` = priority, `Pts` = estimate. Task numbers use `LEM-###`.

## 1. Core Python modules

| Assay module | Capability | Lemma package | Task |
| --- | --- | --- | --- |
| `harness/__init__.py` | Version constant and package surface (scaffolded: `@lemma/core` package shell, strict ESM TS, build/test gates) | `@lemma/core` | LEM-001 |
| `harness/__main__.py` | `python -m harness` entry point (`@lemma/cli` package shell scaffolded; runtime entry pending LEM-083) | `@lemma/cli` | LEM-001, LEM-083 |
| `harness/cli.py` | Machine-first CLI, all subcommands, exit codes | `@lemma/cli` | LEM-083–LEM-085 |
| `harness/orchestrator.py` | Five-phase state machine, budget, kill, resume, finalization (`packages/core/src/orchestrator.ts`: fixed-order workflow orchestration over `StateStore`, run/phase/check transitions and persistence, `maxChecks` budget validation/context, async kill-request checkpoints with halt/skip semantics and halted recording, injectable phase handlers, resume mode with halted/target/workflow/registry-fingerprint guards, crash-safe incomplete-check rerun preparation, contract-state rebuild, and evidence reconciliation integration; tests `packages/core/test/orchestrator/orchestrator.test.ts`, `packages/core/test/resume/resume.test.ts`, `packages/core/test/conformance/orchestrator-conformance.test.ts`, outputs `docs/parity/evidence/LEM-015-orchestrator-test-output.txt`, `docs/parity/evidence/LEM-021-resume-test-output.txt`, `docs/parity/evidence/LEM-026-conformance-test-output.txt`) | `@lemma/core/orchestrator` | LEM-015, LEM-021, LEM-026 |
| `harness/determinism.py` | Injectable clock/entropy, seeded ids, frozen clock (`packages/core/src/determinism.ts`: `Clock`/`Entropy`, `RealClock`/`FrozenClock`, `RealEntropy`/`SeededEntropy`, `makeDeterminism`, active helpers, typed validation) | `@lemma/core/determinism` | LEM-006 |
| `harness/workflows.py` | Versioned workflow loader, phase validation (`packages/core/src/workflows.ts`: dependency-free YAML subset parser, typed validation/errors, `PHASE_ORDER` invariant, built-in `release-confidence`, `loadWorkflowFile`/`loadWorkflows`; tests `packages/core/test/workflows/workflows.test.ts`, output `docs/parity/evidence/LEM-012-workflows-test-output.txt`) | `@lemma/core/workflows` | LEM-012 |
| `harness/checks.py` | Check catalog, definitions, intent planning (`packages/core/src/checks.ts`: 24-check catalog, `catalogIds`, intent/category helpers, applicability, `planChecks` with ownership/registry hooks and typed errors, `applyRiskWeights`; tests `packages/core/test/checks/checks.test.ts`, output `docs/parity/evidence/LEM-014-checks-test-output.txt`) | `@lemma/core/checks` | LEM-014 |
| `harness/plugins.py` | Signed entry-point registry, plugin context, blocked failures | `@lemma/core/plugins` | LEM-075–LEM-082 |
| `harness/personas.py` | Frontmatter parsing, schema validation, ownership, lint (frontmatter parser ported in `packages/core/src/personas.ts`: delimiter validation, assay-compatible scalar/block-list parsing, body/section splitting, typed `PersonaError`, `@lemma/core/personas` subpath export; tests `packages/core/test/personas/personas.test.ts`; output `docs/parity/evidence/LEM-041-personas-test-output.txt`. Output/blocker JSON-Schema subset ported in LEM-042: `CORE_FINDING_FIELDS`/`CORE_BLOCKER_FIELDS`/`SUPPORTED_SCHEMA_TYPES`, `matchesSchemaType`, `extractJsonSchema`, `validatePayload`, `validateBlocker`; tests `packages/core/test/persona-schema/persona-schema-validation.test.ts`; output `docs/parity/evidence/LEM-042-persona-schema-validation-test-output.txt`. Contract loading ported in LEM-043: `Persona`/`loadPersona`/`loadPersonas`/`selectPersonas`/`personaPublic` with required frontmatter/section enforcement, README skip, duplicate-id/selection/minimum checks; tests `packages/core/test/persona-contracts/persona-contracts.test.ts`; output `docs/parity/evidence/LEM-043-persona-contracts-test-output.txt`. Ownership ported in LEM-044: `checkOwnership`/`ownershipErrorMessage`/`unknownPersonaCheckIds`/`validatePersonaChecks`/`validateOwnership`, shared planner error message, and full-catalog ownership (functional frontmatter declares lemma-only `static.category.*` scope markers); tests `packages/core/test/ownership/ownership.test.ts`; output `docs/parity/evidence/LEM-044-ownership-test-output.txt`. Aggregate lint ported in LEM-047: `lintPersonas` returns `quality-harness.personas.lint/v1` diagnostics for load/schema/ownership/registry issues and scaffold placeholders; tests `packages/core/test/persona-lint/persona-lint.test.ts`; output `docs/parity/evidence/LEM-047-persona-lint-test-output.txt`. Scaffold ported in LEM-048: `scaffoldPersona` writes atomic `quality-harness.personas.scaffold/v1` starter contracts with assay-compatible validation/defaults/template/refusal semantics; tests `packages/core/test/persona-scaffold/persona-scaffold.test.ts`; output `docs/parity/evidence/LEM-048-persona-scaffold-test-output.txt`. Tool capability enforcement and shipped-persona conformance ported in LEM-049: `TOOL_CAPABILITY_PATTERN`/`validatePersonaToolCapabilities` enforce non-empty unique `^[a-z][a-z0-9_]*$` frontmatter tool capabilities during load (and lint via load errors), and `packages/core/test/persona-conformance/persona-conformance.test.ts` ports/adapts `test_personas.py` invariants for lemma's full 76-check catalog ownership; output `docs/parity/evidence/LEM-049-persona-conformance-test-output.txt`) | `@lemma/core/personas` | LEM-041–LEM-049 |
| `harness/static_analysis.py` | Inventory, git-aware scope, secret/unsafe/a11y scans, categories (`packages/core/src/static.ts`: `SourceInspector`/`InventoryData` deterministic discovery, classification/limits/flags, git `ls-files -z` tracked/env/CI classification, root-scoped CI config precision (`CI_NAMES` only at repository root, root `.github/workflows/*` preserved, nested/vendor CI-name copies excluded) with git-aware tracked CI filtering, test framework detection, `.harnessignore`-equivalent scoping with canonical `.lemmaignore` + `.harnessignore` alias precedence/pattern+negation-aware traversal and exclusion metadata, and `StaticCheckRunner` for `static.inventory`/`static.tests`/`static.ci`/`static.dependencies`/`static.accessibility`/`static.secrets`/`static.unsafe` plus baseline/specialized category scope checks `static.test_category`/`static.functionality_category`/`static.browser_category`/`static.issues_category`/`static.demo_category`/`static.more_category`, full-assessment marker `static.full_assessment`, and generic documented no-op category scope checks `static.category.<label>` with deterministic `category-scope` `static_analysis` evidence/rationale; assay-compatible evidence, outcomes, findings, markup a11y heuristics, secret-scan redaction/precision rules, unsafe-code pattern rules, and deterministic issue-marker/demo/more/full/category inventory scope behavior including git-aware dependency/env reporting and test-path severity downgrades; parity fixtures `examples/sample-repo/`, `examples/demo-web/`, and `tests/fixtures/redaction_corpus.json` ported (LEM-038); tests `packages/core/test/inventory/inventory.test.ts`, `packages/core/test/harnessignore/harnessignore.test.ts`, `packages/core/test/static-checks/static-checks.test.ts`, `packages/core/test/accessibility-scan/accessibility-scan.test.ts`, `packages/core/test/secret-scan/secret-scan.test.ts`, `packages/core/test/unsafe-scan/unsafe-scan.test.ts`, `packages/core/test/category-checks/category-checks.test.ts`, `packages/core/test/full-assessment/full-assessment.test.ts`, `packages/core/test/ci-root-scoping/ci-root-scoping.test.ts`, `packages/core/test/category-coverage/category-coverage.test.ts`, outputs `docs/parity/evidence/LEM-027-inventory-test-output.txt`, `docs/parity/evidence/LEM-028-harnessignore-test-output.txt`, `docs/parity/evidence/LEM-029-static-checks-test-output.txt`, `docs/parity/evidence/LEM-030-accessibility-scan-test-output.txt`, `docs/parity/evidence/LEM-031-secret-scan-test-output.txt`, `docs/parity/evidence/LEM-032-unsafe-scan-test-output.txt`, `docs/parity/evidence/LEM-033-category-checks-test-output.txt`, `docs/parity/evidence/LEM-034-full-assessment-test-output.txt`, `docs/parity/evidence/LEM-035-ci-root-scoping-test-output.txt`, `docs/parity/evidence/LEM-037-category-coverage-test-output.txt`, `docs/parity/evidence/LEM-038-fixtures-parity.txt`, `docs/parity/evidence/LEM-039-static-precision-recall-test-output.txt`, `docs/parity/evidence/LEM-040-static-linkage-totals-test-output.txt`; static finding-to-evidence linkage and report totals verified by `packages/core/test/static-linkage-totals/static-linkage-totals.test.ts`) | `@lemma/core/static` | LEM-027–LEM-040 |
| `harness/browser.py` | Playwright Operate layer, crawl, capture, scenario steps (LEM-050 runtime slice: optional Playwright probe/load, `BrowserUnavailableError`, `runBrowserChecks`/blocked degradation with one blocked outcome+blocker per browser check and no findings when runtime unavailable/disabled, `packages/browser/src/runtime.ts`, tests `packages/browser/test/browser-runtime.test.ts`, output `docs/parity/evidence/LEM-050-browser-runtime-test-output.txt`; controller/crawl/capture/check evaluators follow in LEM-051–LEM-064) | `@lemma/browser` | LEM-050–LEM-064 |
| `harness/scoring.py` | `weighted-coverage-v1`, caps, gate policy (`packages/core/src/scoring.ts`: formula/constants, `scoreConfidence` with coverage/quality/scope, fingerprint dedupe, severity penalties/suspected halving/cap, score caps/banding, domain scores/breakdown/rationale/limitations, policy defaults/validation/load and gate evaluation; tests `packages/core/test/scoring/scoring.test.ts`, output `docs/parity/evidence/LEM-018-scoring-test-output.txt`; versioned policy file workflows/config integration continue in LEM-019) | `@lemma/core/scoring` | LEM-018, LEM-019 |
| `harness/evidence.py` | Hashed artifact store, manifest, checkpoint, verify (`packages/core/src/evidence.ts`: per-run `.lemma/evidence/<run_id>/` store with portable relative paths, SHA-256/metadata entries and dedupe, artifact save helpers, atomic checkpoint manifests, reconcile/recovery, finalize with manifest path/hash and summary, safe path handling, deterministic HMAC-SHA256 manifest signing with injectable key, and `verify()` tamper detection/hold signaling; tests `packages/core/test/evidence/evidence.test.ts`, `packages/core/test/evidence/evidence-signing.test.ts`, outputs `docs/parity/evidence/LEM-016-evidence-test-output.txt`, `docs/parity/evidence/LEM-017-evidence-signing-test-output.txt`) | `@lemma/core/evidence` | LEM-016, LEM-017 |
| `harness/state.py` | Atomic progress, events, run history, retention, kill file (`packages/core/src/state.ts`: atomic JSON write/read, advisory file lock, ensureDir, kill-file primitives; cross-process/crash-injection tests; CI state matrix ubuntu/macos/windows — LEM-010 evidence `docs/parity/evidence/LEM-010-state-test-output.txt`. `packages/core/src/state-store.ts`: `StateStore` progress/events JSONL, versioned history with upsert/sorting and enriched entries (decision/score/workflow/target/timestamps/evidence path, `finding_counts`, `finding_fingerprints`), retention/prune (`keepRuns`/`olderThanDays`/`dryRun`/`now`) with latest+latest-completed+halted protections, index-before-delete and safe `.lemma/evidence` removal, kill request-observe-clear — LEM-011 evidence `docs/parity/evidence/LEM-011-state-store-test-output.txt`, LEM-023 evidence `docs/parity/evidence/LEM-023-history-test-output.txt`) | `@lemma/core/state` | LEM-010, LEM-011, LEM-023 |
| `harness/report.py` | `quality-harness.report/v1` builder and schema (`packages/core/src/report.ts`: `buildReport`, coverage/decision semantics, sorting/defaults/limitations, dependency-free schema validation; tests `packages/core/test/report/report.test.ts`, output `docs/parity/evidence/LEM-020-report-test-output.txt`; CLI integration/contract parity tests continue in LEM-073+) | `@lemma/core/report` | LEM-020 |
| `harness/models.py` | Domain enums and records (`packages/core/src/models.ts`: assay-compatible enums/constants, severity ranking/clamp, normalization/serde helpers for Target/Risk/Finding/InvalidFinding/Blocker/Check/Phase/Confidence/KillSwitch/RunState with deterministic defaults and round-trips; tests `packages/core/test/models/models.test.ts`, output `docs/parity/evidence/LEM-013-models-test-output.txt`) | `@lemma/core/models` | LEM-004, LEM-013 |
| `harness/errors.py` | Typed error model (`packages/core/src/errors.ts`: domain error classes, stable `ErrorCode`/payloads, `EXIT_CODES` 0/1/2/3/130, `exitCodeForError`/`toErrorPayload`; CLI contract helpers in `packages/cli/src/errors.ts`) | `@lemma/core/errors` | LEM-007 |
| `harness/outcomes.py` | Finding/blocker drafts and check outcomes (`packages/core/src/models.ts`: `FindingDraft`/`BlockerDraft`, `CheckOutcome` with `addFinding`/`addBlocker` and severity-safe normalization behavior; `packages/core/src/outcomes.ts` applies outcomes to state with structured blocker/refusal recording and non-blocked finding validation; tests `packages/core/test/models/models.test.ts`, `packages/core/test/blockers/blockers.test.ts`, outputs `docs/parity/evidence/LEM-013-models-test-output.txt`, `docs/parity/evidence/LEM-046-blockers-test-output.txt`) | `@lemma/core/outcomes` | LEM-013, LEM-046 |
| `harness/risk.py` | Risk ranking from intent, target, and inventory (`packages/core/src/risk.ts`: `RiskAnalyzer`/`analyzeRisk`, intent/target/scope/inventory-driven risks, tracked-file parity for env/CI scope—`env_files_tracked` preferred when `tracked_available` with filesystem fallback, CI-refresh risk driven by scoped `inventory.ci_files` so untracked-only CI is treated as absent—plus dedupe/numbering/cap and deterministic weights/evidence; tests `packages/core/test/risk/risk.test.ts`, `packages/core/test/risk-tracked-parity/risk-tracked-parity.test.ts`, outputs `docs/parity/evidence/LEM-024-risk-test-output.txt`, `docs/parity/evidence/LEM-036-risk-tracked-parity-test-output.txt`) | `@lemma/core/risk` | LEM-024, LEM-036 |
| `harness/redact.py` | Redaction before persistence (`packages/core/src/redaction.ts`: `sanitizeUrl`, `redactText`, `redactSecretValue`, `redactUnknown`, `containsRedactionMarker`; corpus 30 shapes incl. Jira/storage state, artifact-scan evidence `docs/parity/evidence/LEM-008-artifact-scan-output.json`) | `@lemma/core/redact` | LEM-008, LEM-123 |
| `harness/exports.py` | SARIF and JUnit exporters | `@lemma/core/exports` | LEM-065, LEM-066 |
| `harness/calibration.py` | Labeled fixture calibration | `@lemma/core/calibration` | LEM-070, LEM-074 |
| `harness/ssrf.py` | SSRF validation, DNS, allowlists, redirects | `@lemma/core/ssrf` | LEM-059, LEM-125 |
| `harness/step_planner.py` | Scenario step planning (`packages/core/src/steps.ts`: `StepAction`/`ScenarioPlan`, deterministic `HeuristicStepPlanner`, `LLMStepPlanner`/`createStepPlanner` with OpenAI-compatible fetch and heuristic fallback; tests `packages/core/test/steps/steps.test.ts`, output `docs/parity/evidence/LEM-025-steps-test-output.txt`) | `@lemma/core/steps` | LEM-025 |
| `harness/step_runner.py` | Scenario step execution/result contracts (`packages/core/src/steps.ts`: `StepResult`/`ScenarioExecutionResult`, `evaluateScenarioCheck` pass/fail/blocked outcomes, evidence/count metadata, deterministic failed-scenario findings; tests `packages/core/test/steps/steps.test.ts`; Playwright page-driving execution remains in browser integration outside core) | `@lemma/core/steps` | LEM-025 |
| `harness/metering.py` | Frozen v1 usage events, idempotent sink | `@lemma/cloud/metering` | LEM-113 |
| `harness/auth.py` | Workspaces, hashed scoped keys, run ownership, audit | `@lemma/cloud/auth` | LEM-114 |
| `harness/quota.py` | Monthly soft/hard allowance, locking, headers | `@lemma/cloud/quota` | LEM-115 |
| `harness/ledger.py` | Append-only hash-chained ledger, periods, invoices | `@lemma/cloud/ledger` | LEM-116 |
| `harness/signup.py` | Self-serve signup, free allowance, plan selection | `@lemma/cloud/signup` | LEM-117 |
| `harness/entitlements.py` | Signed entitlement compatibility surface | `@lemma/cloud/signup` | LEM-117 |
| `harness/billing.py` | Feature-gated metered billing, sandbox provider, kill switch | `@lemma/cloud/billing` | LEM-118, LEM-121 |
| `harness/queue.py` | Durable tenant queue, polling, cancel, recovery, metrics | `@lemma/cloud/queue` | LEM-119 |
| `harness/retention.py` | Retention policy, signed export, soft/hard delete | `@lemma/cloud/retention` | LEM-120 |
| `harness/py.typed` | Typed package marker (replaced by TS declaration emit in package builds) | Replaced by TS declaration output | LEM-001 |

## 2. CLI command surface

| Assay command | Behavior | Lemma task |
| --- | --- | --- |
| `lemma run` | Five-phase run; JSON report on stdout | LEM-084 |
| `lemma status` | Latest state; `--all` history | LEM-084, LEM-023 |
| `lemma report` | Latest report JSON | LEM-084 |
| `lemma abort` | Write kill file | LEM-084 |
| `lemma prune` | Count/age retention with dry run | LEM-084, LEM-023 |
| `lemma personas` | Load and print contracts | LEM-085 |
| `lemma personas lint` | Aggregate contract validation (`lintPersonas` core API ported in `packages/core/src/personas.ts`, returns `quality-harness.personas.lint/v1`; CLI command wiring follows in LEM-084) | LEM-047, LEM-084 |
| `lemma personas scaffold` | Generate a valid contract (`scaffoldPersona` core API ported in `packages/core/src/personas.ts`, returns `quality-harness.personas.scaffold/v1`; CLI command wiring follows in LEM-084) | LEM-048, LEM-084 |
| `lemma sarif` | SARIF export | LEM-065 |
| `lemma junit` | JUnit export | LEM-066 |
| `lemma sign-report` | Detached HMAC report signature | LEM-067 |
| `lemma verify-report` | Verify report signature | LEM-067 |
| `lemma verify-evidence` | Offline manifest/artifact verification | LEM-071 |
| `lemma suppress add` | Baseline suppression with owner/expiry | LEM-069 |
| `lemma suppress list` | List suppressions | LEM-069 |
| `lemma suppress remove` | Remove suppression | LEM-069 |
| `lemma auth create-workspace` | Create workspace | LEM-114 |
| `lemma auth list-workspaces` | List workspaces | LEM-114 |
| `lemma auth create-key` | Issue scoped key, secret once | LEM-114 |
| `lemma auth list-keys` | Public key metadata | LEM-114 |
| `lemma auth revoke-key` | Revoke with audit | LEM-114 |
| `lemma auth rotate-key` | Atomic replacement, revoke old | LEM-114 |
| `lemma auth authenticate` | Token → auth context | LEM-114 |
| `lemma auth claim-run` | Claim run for one workspace | LEM-114 |
| `lemma auth authorize-run` | Opaque run authorization | LEM-114 |
| `lemma quota show` | Usage, remaining, reset time | LEM-115 |
| `lemma quota consume` | Per-action enforcement, 429 on hard limit | LEM-115 |
| `lemma ledger ingest` | Aggregate events, hash-chain | LEM-116 |
| `lemma ledger entries` | List entries | LEM-116 |
| `lemma ledger periods` | List periods | LEM-116 |
| `lemma ledger close` | Close billing month | LEM-116 |
| `lemma ledger adjust` | Correction/late adjustment | LEM-116 |
| `lemma ledger invoice` | JSON/CSV invoice | LEM-116 |
| `lemma ledger verify` | Hash/sequence continuity | LEM-116 |
| `lemma ledger reconcile` | Invoice vs quantity × price | LEM-116 |
| `lemma signup create` | Idempotent onboarding | LEM-117 |
| `lemma signup select-plan` | Effective-date plan change | LEM-117 |
| `lemma signup usage` | Usage against allowance | LEM-117 |
| `lemma signup verify` | Offline entitlement verification | LEM-117 |
| `lemma billing status` | Feature flag, sandbox, degradation | LEM-118 |
| `lemma billing sync` | Ledger invoice → provider | LEM-118 |
| `lemma billing disable` | Operator kill switch | LEM-118 |
| `lemma billing enable` | Clear kill switch | LEM-118 |
| `lemma calibrate` | Run labeled fixtures | LEM-070 |

Exit codes to preserve: `0` pass, `1` policy threshold failed, `2` harness error
or failed run, `3` kill-switch halt, `130` operator interrupt.

## 3. Agent command surface

The current OpenCode plugin registers the generic `/assay` entry point plus 59
named commands. A separate backup pack contains 61 command files including
`/assay-abort`, `/assay-report`, `/assay-status`, and `/assay-verify-evidence`.
Lemma must provide an equivalent command for every one, either as a deterministic
intent-gated category or as an explicit documented no-op with rationale.

### 3.1 Command groups and migration policy

| Group | Commands | Policy | Task |
| --- | --- | --- | --- |
| Core entry | `/assay` | Generic agent loop: initial deterministic run, context checkpoints, bounded 7-step loop | LEM-086–LEM-094 |
| Browser/demo | `assay-browser`, `assay-demo` | Real browser run when URL present; explicit static inventory otherwise | LEM-063, LEM-089 |
| Baseline categories | `assay-test`, `assay-functionality`, `assay-issues`, `assay-more`, `assay-full`, `full-report` (specialized static category checks/markers `static.test_category`/`static.functionality_category`/`static.browser_category`/`static.issues_category`/`static.demo_category`/`static.more_category` and `static.full_assessment` with deterministic evidence/payloads/actuals/metadata; tests `packages/core/test/category-checks/category-checks.test.ts`, `packages/core/test/full-assessment/full-assessment.test.ts`, `packages/core/test/category-coverage/category-coverage.test.ts`, outputs `docs/parity/evidence/LEM-033-category-checks-test-output.txt`, `docs/parity/evidence/LEM-034-full-assessment-test-output.txt`, `docs/parity/evidence/LEM-037-category-coverage-test-output.txt`) | Deterministic intent-gated checks, evidence-backed | LEM-033, LEM-034, LEM-037 |
| Quality categories | `assay-help`, `assay-accessibility`, `assay-ui`, `assay-ux`, `assay-usability`, `assay-personas`, `assay-compatibility`, `assay-intl`, `assay-localization`, `assay-content`, `assay-geo` | Intent-gated owned scope checks or documented no-ops with rationale/evidence (`static.category.<label>` generic scope markers in core) | LEM-037 |
| Security/risk | `assay-security`, `assay-security-review`, `assay-privacy`, `assay-state`, `assay-reliability`, `assay-performance`, `assay-load`, `assay-stress`, `assay-networking`, `assay-api`, `assay-data`, `assay-failure`, `assay-proof` | Intent-gated owned scope checks or documented no-ops with rationale/evidence; no destructive probes | LEM-037 |
| Confidence/review | `assay-confidence`, `assay-confidence-init`, `assay-confidence-plan`, `assay-review`, `assay-skeptical-review`, `assay-release`, `assay-release-review`, `assay-incident` | Intent-gated owned scope checks or documented no-ops with rationale/evidence | LEM-037 |
| AI/eval | `assay-eval`, `assay-eval-design-review`, `assay-statistical-review`, `assay-agentic`, `assay-chatbot`, `bias` | Intent-gated owned scope checks or documented no-ops with rationale/evidence; no model-generated findings | LEM-037 |
| Authoring/workflow | `assay-tests`, `assay-generate`, `assay-map`, `assay-stats`, `assay-integrations`, `ai-upgrade`, `assay-auto`, `assay-background`, `assay-forever`, `assay-settings`, `assay-human`, `assay-pro`, `assay-manager` | Agent workflow wrappers around deterministic commands | LEM-089 |

### 3.2 Plugin modules

| Assay plugin asset | Capability | Lemma task |
| --- | --- | --- |
| `.opencode/plugins/assay/index.ts` | Plugin setup, command/tool registration, event subscription, resume | LEM-101 |
| `.opencode/plugins/assay/agent.ts` | Strict-judge agent loop, state persistence, context parsing | LEM-086, LEM-087, LEM-091 |
| `.opencode/plugins/assay/command-args.ts` | URL extraction, browser/demo/generic invocation builders | LEM-088, LEM-089 |
| `.opencode/plugins/assay/runner.ts` | Harness subprocess bridge | Replaced by in-process core invocation; LEM-083 |
| `.opencode/plugins/assay/jira-context.ts` | Native Jira form, issue fetch, ADF flattening, redaction | LEM-092 |
| `.opencode/plugins/assay/browser-agent-prompt.ts` | Browser agent prompt and context protocol | LEM-090, LEM-091 |
| `.opencode/plugins/assay/package.json` | Plugin package manifest | LEM-108 |
| `.opencode/plugins/assay/tsconfig.json` | TypeScript config (repo-wide strict TS/tsconfig foundation in place; plugin-specific config pending adapter work) | LEM-001 | LEM-001 |
| `.opencode/commands/_assay_backup/*.md` | 61 command prompt files | LEM-106, LEM-108 |
| `.opencode/commands/assay-browser.md` | Browser command prompt | LEM-090, LEM-106 |

## 4. Personas and checks

| Asset | Capability | Lemma task |
| --- | --- | --- |
| `personas/functional.md` | Functional/reliability/content/data ownership (ported to `packages/personas/functional.md`; loaded by `loadPersona`/`loadPersonas` in `packages/core/src/personas.ts`; LEM-044 extends the `checks` frontmatter with the 52 lemma-only `static.category.*` scope markers so the full 76-id catalog has one owner, while the assay body/tools/domains/schemas stay unchanged; assay subset asserted in `packages/core/test/persona-contracts/persona-contracts.test.ts`, full ownership in `packages/core/test/ownership/ownership.test.ts`; diffs `docs/parity/evidence/LEM-043-assay-persona-diff.txt`, `docs/parity/evidence/LEM-044-functional-contract-extension.txt`) | LEM-043, LEM-044 |
| `personas/security.md` | Secret, unsafe-code, transport, header ownership (ported verbatim to `packages/personas/security.md`; loaded end to end with finding/blocker schema validation in `packages/core/test/persona-contracts/persona-contracts.test.ts`; diff evidence `docs/parity/evidence/LEM-043-assay-persona-diff.txt`) | LEM-043 |
| `personas/accessibility.md` | Markup and rendered accessibility ownership (ported verbatim to `packages/personas/accessibility.md`; loaded end to end with finding/blocker schema validation in `packages/core/test/persona-contracts/persona-contracts.test.ts`; diff evidence `docs/parity/evidence/LEM-043-assay-persona-diff.txt`) | LEM-043 |
| `personas/README.md` | Contract authoring rules (ported verbatim to `packages/personas/README.md` and shipped in the `@lemma/personas` package `files`; diff evidence `docs/parity/evidence/LEM-043-assay-persona-diff.txt`) | LEM-043, LEM-047 |
| Check catalog (core checks incl. static/browser and intent-gated category scope checks) | Stable ids, weights, intents, inputs, and full assay category intent mapping/coverage (`packages/core/src/checks.ts` `CHECK_CATALOG`/`catalogIds`/`ASSAY_CATEGORY_LABELS`/`ASSAY_CATEGORY_INTENTS`/mapping helpers; specialized + generic `static.category.<label>` documented no-op scope checks; planning/coverage tests `packages/core/test/checks/checks.test.ts`, `packages/core/test/category-coverage/category-coverage.test.ts`, outputs `docs/parity/evidence/LEM-014-checks-test-output.txt`, `docs/parity/evidence/LEM-037-category-coverage-test-output.txt`) | LEM-014, LEM-037 |
| Ownership derivation | Frontmatter is the only owner source (`checkOwnership`/`ownershipErrorMessage`/`unknownPersonaCheckIds`/`validatePersonaChecks`/`validateOwnership` in `packages/core/src/personas.ts`; full 76-id catalog resolves to exactly one owner with `CHECK_CATALOG.persona` still empty; `planChecks` now uses the shared assay-compatible error message; tests `packages/core/test/ownership/ownership.test.ts`, output `docs/parity/evidence/LEM-044-ownership-test-output.txt`) | LEM-044 |
| Finding schema validation | Quarantine invalid findings, degraded streak (`@lemma/core/findings` exports `draftPayload`/`findingFromPayload`/`quarantineFinding`/`recordValidContract`/`rebuildContractHealth`/`recordCheckFindings`; invalid drafts stay out of `state.findings`, scoring, and the kill switch; payload/errors are redacted before persistence; report exposes `invalid_findings`/`contract_failures`/`degraded_personas`; tests `packages/core/test/invalid-findings/invalid-findings.test.ts`, output `docs/parity/evidence/LEM-045-invalid-findings-test-output.txt`) | LEM-045 |
| Blocker schema validation | One structured blocker per blocked check (persona blocker schemas validated at load time and blocker records validated/warned at runtime by `@lemma/core/outcomes`; tests `packages/core/test/persona-schema/persona-schema-validation.test.ts`, `packages/core/test/blockers/blockers.test.ts`, output `docs/parity/evidence/LEM-046-blockers-test-output.txt`) | LEM-046 |

Browser check ids to preserve: `browser.load`, `browser.console`,
`browser.network`, `browser.security`, `browser.accessibility`, `browser.content`,
`browser.links`, `browser.overflow`, `browser.focus_order`, `browser.steps`.

Static check ids to preserve: `static.full_assessment`, `static.test_category`,
`static.functionality_category`, `static.browser_category`,
`static.issues_category`, `static.demo_category`, `static.more_category`,
`static.inventory`, `static.secrets`, `static.unsafe`, `static.tests`,
`static.ci`, `static.dependencies`, `static.accessibility`.

## 5. Schemas and contracts

| Assay asset | Capability | Lemma task |
| --- | --- | --- |
| `schemas/report/report.v1.schema.json` | Published report contract (updated to assay-compatible `quality-harness.report/v1` shape with schema-version enum; validated by `packages/core/src/report.ts` and `packages/core/test/report/report.test.ts`; compatibility/contract test expansion continues in LEM-073) | LEM-020, LEM-073 |
| `schemas/report/index.json` | Report schema index (lemma `schemas/report/index.json` references report schema; report contract/builder alignment landed in LEM-020) | LEM-004, LEM-020 |
| `schemas/metering/envelope.v1.schema.json` | Event envelope | LEM-113 |
| `schemas/metering/run_started.v1.schema.json` | Run event | LEM-113 |
| `schemas/metering/check_executed.v1.schema.json` | Check event | LEM-113 |
| `schemas/metering/browser_minute_consumed.v1.schema.json` | Browser-minute event | LEM-113 |
| `schemas/metering/evidence_byte_stored.v1.schema.json` | Evidence-byte event | LEM-113 |
| `schemas/metering/export_generated.v1.schema.json` | Export event | LEM-113 |
| `schemas/metering/index.json` | Metering schema index | LEM-004, LEM-113 |
| Report JSON contract | `schema_version`, decision, confidence, findings, blockers, coverage (implemented/validated in `packages/core/src/report.ts`, `schemas/report/report.v1.schema.json`, `packages/core/test/report/report.test.ts`; evidence `docs/parity/evidence/LEM-020-report-test-output.txt`; broader contract/CLI parity in LEM-073) | LEM-020, LEM-073 |
| Metering v1 event names | Frozen names and idempotency keys | LEM-113 |
| Policy contract (`advisory-v1`, weight overrides) | Versioned gate policy (`policies/advisory-v1.json`, `packages/core/src/scoring.ts` policy validation/load/defaulting and gate semantics; tests `packages/core/test/policy/policy.test.ts`, output `docs/parity/evidence/LEM-019-policy-test-output.txt`; policy/calibration regression coverage continues in LEM-074) | LEM-019, LEM-074 |
| Quota plan contract | `quality-harness.quota-plan/v1` | LEM-115 |
| Price book contract | `quality-harness.price-book/v1` | LEM-116 |
| Entitlement contract | `quality-harness.entitlement/v1` | LEM-117 |

## 6. Fixtures, examples, and packaging

| Assay asset | Capability | Lemma task |
| --- | --- | --- |
| `examples/sample-repo/` | Static fixture with high/medium/low findings (ported to `examples/sample-repo/` incl. CI workflow; parity verified) plus demo/static fixtures `examples/demo-web/`, `tests/fixtures/redaction_corpus.json` (`docs/parity/evidence/LEM-038-fixtures-parity.txt`) | LEM-038 |
| `examples/demo-web/` | Clean browser fixture | LEM-060 |
| `examples/plugins/sample_check.py` | Signed plugin example | LEM-080 |
| `examples/plugins/pyproject.toml` | Plugin packaging example | LEM-080 |
| `examples/plugins/README.md` | Plugin authoring docs | LEM-080 |
| `calibration/fixtures/` | Labeled confidence fixtures | LEM-070 |
| `policies/advisory-v1.json` | Default gate policy (ported to `policies/advisory-v1.json`, schema `quality-harness.policy/v1`; validated/loaded by core policy APIs; evidence `docs/parity/evidence/LEM-019-policy-test-output.txt`) | LEM-019 |
| `Dockerfile` | Core container | LEM-135 |
| `Dockerfile.browser` | Browser container | LEM-135 |
| `pyproject.toml` | Package metadata and console script (npm/TS equivalent contracts: `@lemma/*` manifests, `lemma` bin, exports/optional subpaths, Changesets/provenance release dry-run — ADR 0002, package manifests, `.github/workflows/release-dry-run.yml`) | LEM-009, LEM-134 |
| `requirements.txt` | Dependency declaration (replaced by pnpm workspace manifests and committed `pnpm-lock.yaml`) | LEM-001 | LEM-001 |
| `.github/workflows/ci.yml` | Test + browser matrix | LEM-132, LEM-133 |
| `.github/workflows/release.yml` | Signed release and publish | LEM-134 |
| `.github/workflows/billing-coverage.yml` | Billing coverage job | LEM-121 |
| `.github/workflows/pr.yml` | Fork-safe PR automation | LEM-136 |
| `.github/actions/quality-harness/` | Composite PR action | LEM-136 |
| `tests/plugin/*.test.mjs` | Node plugin tests | LEM-095, LEM-096 |
| `schemas/` release staging | Published schemas as artifacts | LEM-073, LEM-134 |

## 7. Test-suite mapping

Every Python test must have a TypeScript successor or an explicit retirement
with rationale.

| Assay test | Lemma task |
| --- | --- |
| `test_orchestrator_cli.py` | LEM-026, LEM-084 (core orchestrator conformance/integration behavior covered by `packages/core/test/conformance/orchestrator-conformance.test.ts`, output `docs/parity/evidence/LEM-026-conformance-test-output.txt`; CLI contract and end-to-end CLI behavior continue in LEM-084) | LEM-026, LEM-084 |
| `test_workflows.py` | LEM-012 |
| `test_resume.py`, `test_resume_registry.py`, `test_seeded_resume.py` | LEM-021, LEM-022 (core crash-safe resume/rerun-preservation and registry-fingerprint/target guards covered by `packages/core/test/resume/resume.test.ts`; seeded determinism/id-sequence persistence, restore-precedence, and crash-resume continuity/stability covered by `packages/core/test/seeded-resume/seeded-resume.test.ts`, output `docs/parity/evidence/LEM-022-seeded-resume-test-output.txt`; CLI behavior and plugin-registry removal cases continue in follow-on tasks) | LEM-021, LEM-022 |
| `test_determinism.py` | LEM-006 |
| `test_history.py` | LEM-023 (core history recording/enrichment/sorting/upsert and retention/prune protections/dry-run/safe evidence removal covered by `packages/core/test/history/history.test.ts` and `packages/core/test/state/state-store.test.ts`; CLI `status --all`/`prune` command behavior continues in LEM-084) | LEM-023 |
| `test_evidence_state.py`, `test_evidence_signing.py` | LEM-016, LEM-017, LEM-124 |
| `test_scoring.py` | LEM-018 |
| `test_policy.py` | LEM-019, LEM-074 (core policy contract/gate behavior covered by `packages/core/test/policy/policy.test.ts`; CLI/report integration and additional regression coverage continue in later tasks) | LEM-019, LEM-074 |
| `test_report_schema.py` | LEM-020, LEM-073 (core report builder/schema validation behavior covered by `packages/core/test/report/report.test.ts`; CLI-produced report schema/contract parity continues in LEM-073) | LEM-020, LEM-073 |
| `test_personas.py`, `test_persona_tools.py` | LEM-041 (frontmatter parser: `packages/core/test/personas/personas.test.ts`), LEM-042 (schema validation: `packages/core/test/persona-schema/persona-schema-validation.test.ts`), LEM-047 (lint core: `packages/core/test/persona-lint/persona-lint.test.ts`, output `docs/parity/evidence/LEM-047-persona-lint-test-output.txt`; CLI lint command in LEM-084), LEM-048 (scaffold core: `packages/core/test/persona-scaffold/persona-scaffold.test.ts`, output `docs/parity/evidence/LEM-048-persona-scaffold-test-output.txt`; CLI scaffold command in LEM-084), LEM-049 (persona conformance: `packages/core/test/persona-conformance/persona-conformance.test.ts`, output `docs/parity/evidence/LEM-049-persona-conformance-test-output.txt`) |
| `test_ownership.py` | LEM-044 (ownership derivation/disjointness and planning errors ported to `packages/core/src/personas.ts` with the shared assay error message; tests `packages/core/test/ownership/ownership.test.ts`, output `docs/parity/evidence/LEM-044-ownership-test-output.txt`) | LEM-044 |
| `test_invalid_findings.py` | LEM-045 (raw draft extraction, output-schema validation, quarantine without scoring/kill, redaction, consecutive-failure streaks/degradation, streak reset, and rebuild-after-resume-pruning covered by `packages/core/test/invalid-findings/invalid-findings.test.ts`, output `docs/parity/evidence/LEM-045-invalid-findings-test-output.txt`) | LEM-045 |
| `test_blockers.py` | LEM-046 (core blocker/refusal record behavior: blocked outcome one-blocker/no-findings, forced-blocked on blocker draft, discarded findings, dedupe, fallback hints/payload, redaction, and coverage/report integration covered by `packages/core/test/blockers/blockers.test.ts`, output `docs/parity/evidence/LEM-046-blockers-test-output.txt`; plugin-planning/browser-blocked integration follows with their layers) | LEM-046 |
| `test_plugins.py` | LEM-075–LEM-082 |
| `test_browser_smoke.py`, `test_browser_capture.py`, `test_browser_crawl.py` | LEM-051, LEM-054, LEM-057, LEM-060 |
| `test_authenticated_browser.py` | LEM-056 |
| `test_mobile_browser.py` | LEM-055 |
| `test_browser_category.py` | LEM-033 (core static check behavior covered by `packages/core/test/category-checks/category-checks.test.ts`; orchestrator/intent-planning integration parity remains in scope where applicable) |
| `test_test_category.py`, `test_functionality_category.py`, `test_issues_category.py`, `test_demo_category.py`, `test_more_category.py`, `test_full_category.py` | LEM-033, LEM-034, LEM-038 (core baseline category checks for test/functionality/browser/issues/demo/more covered by `packages/core/test/category-checks/category-checks.test.ts`; full-assessment marker check covered by `packages/core/test/full-assessment/full-assessment.test.ts`; report/orchestrator integration parity continues in LEM-034/LEM-038) |
| `test_static_precision.py`, `test_scope_and_tracking.py` | LEM-031, LEM-032, LEM-035, LEM-036, LEM-039 (secrets/unsafe precision rules, scope/ignore behavior, CI/root and tracked-file parity covered by targeted core tests; deterministic labeled precision/recall corpus added at `packages/core/test/static-precision-recall-corpus/corpus.json` with `packages/core/test/static-precision-recall-corpus/static-precision-recall.test.ts`, output `docs/parity/evidence/LEM-039-static-precision-recall-test-output.txt`) |
| `test_exports.py` | LEM-065, LEM-066 |
| `test_suppression.py` | LEM-069 |
| `test_trend.py` | LEM-068 |
| `test_calibration.py` | LEM-070 |
| `test_ssrf.py` | LEM-059, LEM-125 |
| `test_redaction_corpus.py` (ported corpus/tests: `packages/core/test/redaction/redaction.test.ts`, `packages/core/test/redaction/fixtures/redaction-corpus.json`, `docs/parity/evidence/LEM-008-artifact-scan-output.json`) | LEM-008, LEM-123 |
| `test_failure_injection.py` | LEM-126 |
| `test_metering.py` | LEM-113 |
| `test_auth.py` | LEM-114 |
| `test_quota.py` | LEM-115 |
| `test_ledger.py` | LEM-116 |
| `test_signup.py` | LEM-117 |
| `test_billing.py`, `test_billing_regression.py` | LEM-118, LEM-121 |
| `test_queue.py` | LEM-119 |
| `test_retention.py` | LEM-120 |
| `test_packaging.py` | LEM-134 |
| `test_github_action.py` | LEM-136 |
| `test_assay_command_contract.py` | LEM-095 |
| `tests/plugin/agent-loop.test.mjs` | LEM-096 |
| `tests/plugin/browser-agent-prompt.test.mjs` | LEM-096 |
| `tests/plugin/command-args.test.mjs` | LEM-095 |
| `tests/plugin/jira-context.test.mjs` | LEM-092 |

## 8. Behavior decisions to preserve

The assay Decision Log (D1–D51) contains commitments that lemma must carry over
unless an ADR says otherwise. The highest-risk ones:

| Decision | Commitment | Lemma owner |
| --- | --- | --- |
| D1 | Orchestrator is deterministic code, not an autonomous loop | LEM-015, LEM-086 |
| D2 | Missing browser blocks checks, never fails the run (LEM-050: unavailable/disabled Playwright runtime degrades planned browser checks to blocked outcomes with actionable blockers and no findings via `@lemma/browser` runtime; evidence `docs/parity/evidence/LEM-050-browser-runtime-test-output.txt`) | LEM-050 |
| D3 | Score is `weighted-coverage-v1`, not a model probability | LEM-018 |
| D4 | CLI/JSON-first, no UI in OSS core | LEM-083 |
| D8 | Redaction before persistence | LEM-008, LEM-123 |
| D12 | Evidence checkpoint before progress write | LEM-016 |
| D13 | Signed plugins; load failure is a blocked check | LEM-075, LEM-076 |
| D16 | Persona frontmatter is the only ownership source (LEM-044 ports `checkOwnership`/`validateOwnership` and extends the functional frontmatter with lemma-only `static.category.*` scope markers; evidence `docs/parity/evidence/LEM-044-ownership-test-output.txt`) | LEM-044 |
| D17 | Invalid findings quarantined, never scored (LEM-045 ports raw-payload extraction, schema validation/quarantine, redaction, contract-failure streaks, degradation, and rebuild-after-resume to `@lemma/core/findings`; evidence `docs/parity/evidence/LEM-045-invalid-findings-test-output.txt`) | LEM-045 |
| D18 | One structured blocker per blocked check (LEM-046 ports blocker payload derivation, redacted blocker records, dedupe, and refusal outcome application to `@lemma/core/outcomes`; evidence `docs/parity/evidence/LEM-046-blockers-test-output.txt`) | LEM-046 |
| D21 | Frozen metering v1 names and idempotency keys | LEM-113 |
| D22 | Hashed scoped keys; opaque cross-tenant lookups | LEM-114 |
| D23 | Per-action quota enforcement | LEM-115 |
| D24 | Append-only hash-chained ledger | LEM-116 |
| D27 | Tenant queue and isolated roots | LEM-119 |
| D31 | One marker-based PR comment, fork-safe | LEM-136 |
| D33 | Redaction corpus scans every artifact | LEM-123 |
| D34 | Signed evidence manifest; tamper forces hold | LEM-017, LEM-124 |
| D35 | SSRF fail-closed with explicit allowlists | LEM-059, LEM-125 |
| D41 | `/assay-browser` requires a real URL | LEM-063, LEM-089 |
| D42 | Bounded same-origin crawl, per-route evidence | LEM-054 |
| D46 | Git-aware repository claims and `.harnessignore` (git-aware tracked/ignored env and tracked-only CI inventory landed in LEM-027; `.lemmaignore` canonical + `.harnessignore` alias scoping semantics/precedence, negation-aware exclusion, and explicit overrides landed in LEM-028) | LEM-027, LEM-028 |
| D47 | Precise unsafe-code rules (assay-compatible `UNSAFE_RULES` and `static.unsafe` scan with eval/exec precision, capped/grouped findings, and test-path downgrade landed in `packages/core/src/static.ts`; tests/output `packages/core/test/unsafe-scan/unsafe-scan.test.ts`, `docs/parity/evidence/LEM-032-unsafe-scan-test-output.txt`) | LEM-032 |
| D48 | Demo is inventory without a URL, real browser with one | LEM-063, LEM-089 |
| D51 | Jira token never reaches model, state, logs, or report | LEM-092 |

## 9. Intentional divergences from assay

| Change | Reason | Owner |
| --- | --- | --- |
| TypeScript/ESM instead of Python | Ship as agent plugins; single ecosystem for hosts | LEM-003 |
| In-process core instead of Python subprocess bridge | Remove Python runtime, absolute checkout paths, and install friction | LEM-083, LEM-101 |
| `.lemma/` state root instead of `.harness/` | Product rename; keep an explicit migration/read shim | LEM-010, LEM-138 |
| Host-neutral agent SDK | Avoid five copies of the loop and prompts | LEM-098 |
| Capability negotiation | Hosts differ; silent emulation would be dishonest | LEM-099 |
| Installer CLI | One-command install per host | LEM-107 |
| Core runtime deps (`zod`, YAML parser) | Typed schemas and workflow parsing without hand-rolled validation (`zod` added to `@lemma/core`; YAML parser pending LEM-012) | LEM-004, LEM-012 |

## 10. Completeness checklist

- [ ] Every `harness/*.py` module mapped (34/34, plus `py.typed`)
- [ ] Every top-level CLI command and subcommand mapped (50/50)
- [ ] Every named plugin command mapped (59/59 + generic `/assay`)
- [ ] Every persona and check id mapped (3 personas, 24 checks)
- [ ] Every schema mapped (9 files)
- [ ] Every example, fixture, policy, and container asset mapped
- [ ] Every one of the 51 Python test files mapped
- [ ] Every decision that changes behavior has an owner
- [ ] `docs/parity/assay.manifest.json` passes `pnpm parity:check`
- [ ] Full parity audit signed off in LEM-139
