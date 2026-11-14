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
| `harness/orchestrator.py` | Five-phase state machine, budget, kill, resume, finalization | `@lemma/core/orchestrator` | LEM-015, LEM-026 |
| `harness/determinism.py` | Injectable clock/entropy, seeded ids, frozen clock (`packages/core/src/determinism.ts`: `Clock`/`Entropy`, `RealClock`/`FrozenClock`, `RealEntropy`/`SeededEntropy`, `makeDeterminism`, active helpers, typed validation) | `@lemma/core/determinism` | LEM-006 |
| `harness/workflows.py` | Versioned workflow loader, phase validation | `@lemma/core/workflows` | LEM-012 |
| `harness/checks.py` | Check catalog, definitions, intent planning | `@lemma/core/checks` | LEM-014 |
| `harness/plugins.py` | Signed entry-point registry, plugin context, blocked failures | `@lemma/core/plugins` | LEM-075–LEM-082 |
| `harness/personas.py` | Frontmatter parsing, schema validation, ownership | `@lemma/core/personas` | LEM-041–LEM-049 |
| `harness/static_analysis.py` | Inventory, git-aware scope, secret/unsafe/a11y scans, categories | `@lemma/core/static` | LEM-027–LEM-040 |
| `harness/browser.py` | Playwright Operate layer, crawl, capture, scenario steps | `@lemma/browser` | LEM-050–LEM-064 |
| `harness/scoring.py` | `weighted-coverage-v1`, caps, gate policy | `@lemma/core/scoring` | LEM-018, LEM-019 |
| `harness/evidence.py` | Hashed artifact store, manifest, checkpoint, verify | `@lemma/core/evidence` | LEM-016, LEM-017 |
| `harness/state.py` | Atomic progress, events, run history, retention, kill file | `@lemma/core/state` | LEM-010, LEM-011, LEM-023 |
| `harness/report.py` | `quality-harness.report/v1` builder and schema | `@lemma/core/report` | LEM-020 |
| `harness/models.py` | Domain enums and records (zod schema/type foundations landed; domain enums/normalization pending LEM-013) | `@lemma/core/models` | LEM-004, LEM-013 |
| `harness/errors.py` | Typed error model | `@lemma/core/errors` | LEM-007 |
| `harness/outcomes.py` | Finding/blocker drafts and check outcomes | `@lemma/core/outcomes` | LEM-013, LEM-046 |
| `harness/risk.py` | Risk ranking from inventory | `@lemma/core/risk` | LEM-024, LEM-036 |
| `harness/redact.py` | Redaction before persistence | `@lemma/core/redact` | LEM-008, LEM-123 |
| `harness/exports.py` | SARIF and JUnit exporters | `@lemma/core/exports` | LEM-065, LEM-066 |
| `harness/calibration.py` | Labeled fixture calibration | `@lemma/core/calibration` | LEM-070, LEM-074 |
| `harness/ssrf.py` | SSRF validation, DNS, allowlists, redirects | `@lemma/core/ssrf` | LEM-059, LEM-125 |
| `harness/step_planner.py` | Scenario step planning | `@lemma/core/steps` | LEM-025 |
| `harness/step_runner.py` | Scenario step execution | `@lemma/core/steps` | LEM-025 |
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
| `lemma personas lint` | Aggregate contract validation | LEM-047 |
| `lemma personas scaffold` | Generate a valid contract | LEM-048 |
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
| Baseline categories | `assay-test`, `assay-functionality`, `assay-issues`, `assay-more`, `assay-full`, `full-report` | Deterministic intent-gated checks, evidence-backed | LEM-033, LEM-034, LEM-037 |
| Quality categories | `assay-help`, `assay-accessibility`, `assay-ui`, `assay-ux`, `assay-usability`, `assay-personas`, `assay-compatibility`, `assay-intl`, `assay-localization`, `assay-content`, `assay-geo` | Intent-gated inventory or no-op with rationale | LEM-037 |
| Security/risk | `assay-security`, `assay-security-review`, `assay-privacy`, `assay-state`, `assay-reliability`, `assay-performance`, `assay-load`, `assay-stress`, `assay-networking`, `assay-api`, `assay-data`, `assay-failure`, `assay-proof` | Intent-gated checks or no-op; no destructive probes | LEM-037 |
| Confidence/review | `assay-confidence`, `assay-confidence-init`, `assay-confidence-plan`, `assay-review`, `assay-skeptical-review`, `assay-release`, `assay-release-review`, `assay-incident` | Intent-gated evidence and review scope | LEM-037 |
| AI/eval | `assay-eval`, `assay-eval-design-review`, `assay-statistical-review`, `assay-agentic`, `assay-chatbot`, `bias` | Intent-gated scope or no-op; no model-generated findings | LEM-037 |
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
| `personas/functional.md` | Functional/reliability/content/data ownership | LEM-043 |
| `personas/security.md` | Secret, unsafe-code, transport, header ownership | LEM-043 |
| `personas/accessibility.md` | Markup and rendered accessibility ownership | LEM-043 |
| `personas/README.md` | Contract authoring rules | LEM-043, LEM-047 |
| Check catalog (24 checks: `static.*`, `browser.*`) | Stable ids, weights, intents, inputs | LEM-014, LEM-037 |
| Ownership derivation | Frontmatter is the only owner source | LEM-044 |
| Finding schema validation | Quarantine invalid findings, degraded streak | LEM-045 |
| Blocker schema validation | One structured blocker per blocked check | LEM-046 |

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
| `schemas/report/report.v1.schema.json` | Published report contract | LEM-020, LEM-073 |
| `schemas/report/index.json` | Report schema index (lemma `schemas/report/index.json` generated/committed) | LEM-004, LEM-020 |
| `schemas/metering/envelope.v1.schema.json` | Event envelope | LEM-113 |
| `schemas/metering/run_started.v1.schema.json` | Run event | LEM-113 |
| `schemas/metering/check_executed.v1.schema.json` | Check event | LEM-113 |
| `schemas/metering/browser_minute_consumed.v1.schema.json` | Browser-minute event | LEM-113 |
| `schemas/metering/evidence_byte_stored.v1.schema.json` | Evidence-byte event | LEM-113 |
| `schemas/metering/export_generated.v1.schema.json` | Export event | LEM-113 |
| `schemas/metering/index.json` | Metering schema index | LEM-004, LEM-113 |
| Report JSON contract | `schema_version`, decision, confidence, findings, blockers, coverage | LEM-020, LEM-073 |
| Metering v1 event names | Frozen names and idempotency keys | LEM-113 |
| Policy contract (`advisory-v1`, weight overrides) | Versioned gate policy | LEM-019, LEM-074 |
| Quota plan contract | `quality-harness.quota-plan/v1` | LEM-115 |
| Price book contract | `quality-harness.price-book/v1` | LEM-116 |
| Entitlement contract | `quality-harness.entitlement/v1` | LEM-117 |

## 6. Fixtures, examples, and packaging

| Assay asset | Capability | Lemma task |
| --- | --- | --- |
| `examples/sample-repo/` | Static fixture with high/medium/low findings | LEM-038 |
| `examples/demo-web/` | Clean browser fixture | LEM-060 |
| `examples/plugins/sample_check.py` | Signed plugin example | LEM-080 |
| `examples/plugins/pyproject.toml` | Plugin packaging example | LEM-080 |
| `examples/plugins/README.md` | Plugin authoring docs | LEM-080 |
| `calibration/fixtures/` | Labeled confidence fixtures | LEM-070 |
| `policies/advisory-v1.json` | Default gate policy | LEM-019 |
| `Dockerfile` | Core container | LEM-135 |
| `Dockerfile.browser` | Browser container | LEM-135 |
| `pyproject.toml` | Package metadata and console script | LEM-009, LEM-134 |
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
| `test_orchestrator_cli.py` | LEM-026, LEM-084 |
| `test_workflows.py` | LEM-012 |
| `test_resume.py`, `test_resume_registry.py`, `test_seeded_resume.py` | LEM-021, LEM-022 |
| `test_determinism.py` | LEM-006 |
| `test_history.py` | LEM-023 |
| `test_evidence_state.py`, `test_evidence_signing.py` | LEM-016, LEM-017, LEM-124 |
| `test_scoring.py` | LEM-018 |
| `test_policy.py` | LEM-019, LEM-074 |
| `test_report_schema.py` | LEM-020, LEM-073 |
| `test_personas.py`, `test_persona_tools.py` | LEM-041, LEM-047, LEM-048 |
| `test_ownership.py` | LEM-044 |
| `test_invalid_findings.py` | LEM-045 |
| `test_blockers.py` | LEM-046 |
| `test_plugins.py` | LEM-075–LEM-082 |
| `test_browser_smoke.py`, `test_browser_capture.py`, `test_browser_crawl.py` | LEM-051, LEM-054, LEM-057, LEM-060 |
| `test_authenticated_browser.py` | LEM-056 |
| `test_mobile_browser.py` | LEM-055 |
| `test_browser_category.py` | LEM-033 |
| `test_test_category.py`, `test_functionality_category.py`, `test_issues_category.py`, `test_demo_category.py`, `test_more_category.py`, `test_full_category.py` | LEM-033, LEM-034, LEM-038 |
| `test_static_precision.py`, `test_scope_and_tracking.py` | LEM-031, LEM-032, LEM-035, LEM-036, LEM-039 |
| `test_exports.py` | LEM-065, LEM-066 |
| `test_suppression.py` | LEM-069 |
| `test_trend.py` | LEM-068 |
| `test_calibration.py` | LEM-070 |
| `test_ssrf.py` | LEM-059, LEM-125 |
| `test_redaction_corpus.py` | LEM-008, LEM-123 |
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
| D2 | Missing browser blocks checks, never fails the run | LEM-050 |
| D3 | Score is `weighted-coverage-v1`, not a model probability | LEM-018 |
| D4 | CLI/JSON-first, no UI in OSS core | LEM-083 |
| D8 | Redaction before persistence | LEM-008, LEM-123 |
| D12 | Evidence checkpoint before progress write | LEM-016 |
| D13 | Signed plugins; load failure is a blocked check | LEM-075, LEM-076 |
| D16 | Persona frontmatter is the only ownership source | LEM-044 |
| D17 | Invalid findings quarantined, never scored | LEM-045 |
| D18 | One structured blocker per blocked check | LEM-046 |
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
| D46 | Git-aware repository claims and `.harnessignore` | LEM-027, LEM-028 |
| D47 | Precise unsafe-code rules | LEM-032 |
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
