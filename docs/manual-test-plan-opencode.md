# Lemma on OpenCode — End-to-End Manual Test Plan

This document is a detailed manual test plan for validating Lemma in **OpenCode** on a target repository you want to test.

**Scope covered in this plan**
- Simple installation flow for a new user (install Lemma for OpenCode and run `/lemma`)
- End-to-end validation of **all OpenCode slash commands** exposed by the Lemma catalog
- End-to-end validation of **all Lemma CLI commands** (runnable from the OpenCode terminal)
- Cross-cutting checks (stdout/stderr contract, evidence, redaction, coverage-gap honesty, halt behavior, capability honesty)

> **Note (current repo/build):** In this repository, OpenCode integration assets are installed via `lemma install opencode` (commands/skill files under `.opencode/`). Some host runtime surfaces may be provisional/unverified depending on environment; record capability-honest limitations (never treat blocked/skipped/unavailable work as a pass).

---

## 1. Simple installation (new user flow)

### 1.1 Prerequisites
- Node.js **20+** (Node 22 recommended)
- `pnpm`
- OpenCode
- The repository you want to test (target repo)

### 1.2 Install/build Lemma once
```bash
git clone https://github.com/hbahuguna/lemma.git
cd lemma
pnpm install --frozen-lockfile
pnpm build
```

Optional (recommended): set a CLI shortcut in your shell
```bash
export LEMMA_CLI="node /absolute/path/to/lemma/packages/cli/dist/cli.js"
```

### 1.3 Install Lemma for OpenCode in your target repo
```bash
cd /absolute/path/to/your-target-repo
node /absolute/path/to/lemma/packages/cli/dist/cli.js install opencode --dir .
```

**What this does**
- Installs deterministic OpenCode assets in the target repo:
  - `.opencode/commands/` (Lemma command files, including catalog + operational commands)
  - `.opencode/skills/lemma/SKILL.md`

### 1.4 Start using Lemma in OpenCode
1. Open the **target repo** in OpenCode.
2. Reload/reopen the workspace if needed so commands are discovered.
3. In OpenCode chat, run:
   - `/lemma-help` (to confirm commands are available)
   - `/lemma release confidence for this repo` (or just `/lemma`)

**Success criteria (simple flow)**
- `install opencode` completes successfully
- `.opencode/commands/` and `.opencode/skills/lemma/SKILL.md` exist
- `/lemma-help` responds in OpenCode
- `/lemma` starts a Lemma assessment/conversation flow (or returns a clear, capability-honest error if a required runtime component is unavailable)

---

## 2. Test environment, data, and evidence

### 2.1 Test inputs/repositories
- **Lemma repo:** built checkout (for CLI and install)
- **Target repo A (recommended):** app/repo you want to assess (code + git history)
- **Target repo B (optional):** web app with a reachable URL (for `/lemma-browser`, accessibility/browser flows)
- **Target repo C (optional):** disposable copy with legacy `.harness/` state (for `migrate-state`)
- **Disposable sandbox:** copy/branch for tests that mutate files (`auto`, `tests`, `upgrade`, suppressions/settings as applicable)

### 2.2 Environment notes (record before testing)
- OS / OpenCode version
- Node.js and pnpm versions
- Lemma commit SHA/build used
- Browser runtime availability (Playwright/Chromium)
- Pro entitlement/license availability (if testing Pro-gated commands)
- Any configured integrations/services (if applicable)

### 2.3 Artifacts to inspect during testing
- `.lemma/` state (progress, history, settings, continuous/forever/pro subtrees as applicable)
- `.lemma/evidence/<run_id>/` and manifests/hashes
- Reports (`lemma report`, exported files, stdout JSON from `run`)
- Generated/modified files from install/tests/upgrade flows (use disposable repo copies)

### 2.4 Global invariants (must hold)
- `lemma run` prints **one JSON report to stdout**; progress/warnings go to **stderr**
- State/evidence writes are atomic; no half-written manifests/progress on normal completion
- **No evidence, no finding**
- Blocked/skipped/errored/refused work is a **coverage gap** (never pass, never raises confidence)
- Halted runs stay halted and force **hold** (no automatic resume)
- Missing host capabilities degrade honestly (recorded limitation, no silent emulation)
- Secrets/credentials must not be persisted in `.lemma/`, evidence, logs, stdout, or reports

### 2.5 Per-test recording template
For each test case capture:
- Test ID / command / target repo
- Preconditions
- Exact steps/inputs
- Expected result
- Actual result
- Exit code and stdout/stderr notes (CLI)
- Chat transcript/screenshot (slash commands)
- Artifacts/evidence paths (`.lemma/...`)
- Result: **Pass / Fail / Blocked / Degraded-as-expected**
- Notes/defects (redact secrets)

---

## 3. OpenCode install and discovery checks

| ID | Test | Steps | Expected result | Evidence |
|---|---|---|---|---|
| INS-01 | Install for OpenCode | Run `install opencode --dir .` in target repo | Success JSON; installs `.opencode/commands/` and `.opencode/skills/lemma/SKILL.md` | CLI output, file listing |
| INS-02 | Reinstall idempotency | Run install again without `--force` | Existing assets skipped/not overwritten unexpectedly | CLI output |
| INS-03 | Dry run | Run `install opencode --dir <temp> --dry-run` | Plan reported, no files written | CLI output, empty dir |
| INS-04 | Force overwrite | Modify a generated command file, rerun with `--force` | File overwritten/restored to generated content | diff before/after |
| INS-05 | Command discovery in OpenCode | Open target repo in OpenCode, reload if needed | Lemma slash commands are discoverable; `/lemma-help` works | screenshot/transcript |
| INS-06 | Simple happy path | Run `/lemma-help`, then `/lemma` | Help shown; `/lemma` starts working flow or gives clear honest limitation | transcript |

---

## 4. OpenCode slash command end-to-end tests (all commands)

> Execute in OpenCode chat in the target repo. Where a command requires URL/browser/runtime/entitlement/services, test both the **available** and **unavailable/invalid** paths and record honest degradation.

### 4.1 Manager, help, dashboard, and control commands

| ID | Command(s) | Preconditions | Steps | Expected result | Evidence |
|---|---|---|---|---|---|
| SL-01 | `/lemma-help` | INS-05 complete | Run `/lemma-help` | Shows available Lemma slash commands and usage hints | transcript |
| SL-02 | `/lemma [goal]` | Target repo open | Run `/lemma`; then `/lemma assess release confidence for this repo` | Starts/resumes conversational manager assessment; optional goal accepted; empty input handled gracefully | transcript, `.lemma/` |
| SL-03 | `/jay`, `/lemma-jay` | Target repo open | Run `/jay`; run `/lemma-jay` with goal | Both route to manager-guided assessment conversation | transcript |
| SL-04 | `/lemma-background [action]` | None (feature may be unavailable) | Run `/lemma-background`, `status`, `pause`, `resume`, `stop`, and invalid action | Valid actions report/control background behavior; invalid action returns clear error; unavailable returns honest limitation (no crash) | transcript |
| SL-05 | `/lemma-map [run_id]` | Optional existing run for `run_id` case | Run `/lemma-map`; run with valid/invalid run id | Opens/returns journey/evidence map dashboard route or clear `dashboard_unavailable`/`run_not_found` | transcript/URL |
| SL-06 | `/lemma-settings` | Dashboard/settings support | Run `/lemma-settings` | Opens protected settings or returns `dashboard_unavailable`/`unauthorized` | transcript |
| SL-07 | `/lemma-pro` | Dashboard/pro support | Run `/lemma-pro` | Opens pro/dashboard surface or returns availability/entitlement error honestly | transcript |

### 4.2 Core catalog assessment commands

| ID | Command(s) | Preconditions | Steps | Expected result | Evidence |
|---|---|---|---|---|---|
| SL-08 | `/lemma-test [target_or_args]` | Target repo/path/URL context as needed | Run `/lemma-test`; run with target args | Routes to test assessment intent; runs/plans assessment and reports results or clear validation/unavailable errors | transcript, `.lemma/` |
| SL-09 | `/lemma-issues [target_or_args]` | Same | Run with and without args | Routes to issues assessment intent; outputs findings/coverage gaps/evidence refs as applicable | transcript, report |
| SL-10 | `/lemma-accessibility [target_or_args]` | URL helpful for live checks | Run on target URL/path; run when browser/runtime unavailable | Accessibility assessment intent executes or degrades honestly (blocked/coverage gap, never pass) | transcript, evidence |
| SL-11 | `/full`, `/lemma-full [target_or_args]` | Target context available | Run `/full`; run `/lemma-full <target>` | Full assessment intent routed; broader bounded assessment executes/plans correctly | transcript, report/state |

### 4.3 Pro-gated specialist and pro workflow commands

| ID | Command(s) | Preconditions | Steps | Expected result | Evidence |
|---|---|---|---|---|---|
| SL-12 | `/lemma-confidence [target_or_args]` | Test unlicensed and licensed (if available) | Run without entitlement; run with entitlement and valid target | Unlicensed: entitlement/pro-unavailable refusal (no partial execution); licensed: specialist investigation runs | transcript, artifacts |
| SL-13 | `/lemma-security [target_or_args]` | Same | Unlicensed + licensed/valid target | Clean refusal when unlicensed; security specialist runs when licensed | transcript |
| SL-14 | `/lemma-performance [target_or_args]` | Same | Unlicensed + licensed/valid target | Clean refusal when unlicensed; performance specialist runs when licensed | transcript |
| SL-15 | `/lemma-privacy [target_or_args]` | Same | Unlicensed + licensed/valid target | Clean refusal when unlicensed; privacy specialist runs when licensed | transcript |
| SL-16 | `/lemma-proof`, `/proof [property_and_target]` | Entitlement for positive path | Run `/proof`; run with property/target; test invalid/missing inputs | Unlicensed refused; invalid inputs produce clear errors; licensed proof workflow runs and records evidence-backed output (no fabricated pass) | transcript, artifacts |
| SL-17 | `/lemma-eval`, `/eval [cases]` | Entitlement and cases fixture for positive path | Run `/lemma-eval`; run with cases path/id; test invalid cases | Unlicensed refused; invalid cases reported; licensed eval workflow runs and emits documented artifacts | transcript, output files |

### 4.4 Continuation, browser, generation, intent management, and review commands

| ID | Command(s) | Preconditions | Steps | Expected result | Evidence |
|---|---|---|---|---|---|
| SL-18 | `/lemma-more [run_id]` | Run with deferred checks (or test error cases) | Run `/lemma-more`; run with explicit run id; test no deferred checks / mismatch / missing run | Continues same bounded run with next deferred checks when valid; returns clear errors (`no_deferred_checks`, `registry_fingerprint_mismatch`, `run_not_found`) otherwise | transcript, progress/report |
| SL-19 | `/lemma-auto [max_cycles] [resume]` | Disposable sandbox repo | Run `/lemma-auto`; set bounded cycles; test resume; test mutation approval decline | Bounded auto test-fix-retest loop; respects limits/budgets; mutations approval-gated; decline and resume handled correctly | transcript, checkpoints |
| SL-20 | `/lemma-browser <url> [checks]` | **URL required**; browser runtime for live positive path | Run valid URL; run with check subset; run without URL; run with browser unavailable | Focused browser inspection with durable evidence when available; `invalid_target` on bad/missing URL; `browser_unavailable` degrades honestly | transcript, evidence |
| SL-21 | `/lemma-human [run_id/questions]` | Optional run/questions catalog | Run `/lemma-human`; provide run id/questions; include unanswered material question case | Records human decision context; unanswered material questions hold decision (not pass); invalid catalog errors clear | transcript, stored context |
| SL-22 | `/lemma-generate [source] [max_tests]` | Repo/page/requirements context as needed | Run `/lemma-generate`; try supported sources and `max_tests`; test invalid source/scope | Generates prioritized, planned test intents **without execution**; caps/validation enforced | transcript, generated intents |
| SL-23 | `/lemma-tests [action] [format]` | Writable sandbox; sample import/convert inputs as needed | Exercise `list`, `create`, `import`, `convert`, `repair`, `bake`, `delete` with supported formats and invalid cases | Durable test intent lifecycle works; validation/import errors explicit; no silent corruption | transcript, files/state |
| SL-24 | `/lemma-upgrade [kind]` | Sample framework artifacts or supported inputs | Run dry-run first; attempt approval-gated apply; test decline/invalid source | Dry-run previews plan; apply requires approval; decline avoids unintended mutation; validation errors reported | transcript, diffs/artifacts |
| SL-25 | `/lemma-review [run_id] [reviewer]` | Completed run with evidence/findings | Run with valid run and owner-distinct reviewer; test same-owner/missing run/validation failures | Independent evidence review recorded as explicit notes; run decision not silently overridden; errors handled (`persona_error`, `run_not_found`, `validation_failed`) | transcript, review artifacts |

---

## 5. CLI command end-to-end tests (OpenCode terminal)

Run in the target repo terminal inside OpenCode unless noted. Use:
```bash
export LEMMA_CLI="node /absolute/path/to/lemma/packages/cli/dist/cli.js"
$LEMMA_CLI <command> [options]
```

> Capture exit code, stdout, stderr, and resulting artifacts for each case.

| ID | CLI command | Steps | Expected result | Evidence |
|---|---|---|---|---|
| CLI-01 | `--help` / help surface | `$LEMMA_CLI --help` | Lists CLI commands/usage (machine-readable JSON help in this build) | stdout |
| CLI-02 | `install` | `install opencode --dir .`, rerun, `--dry-run`, `--force` (and optional other hosts dry-run) | Deterministic assets, idempotent behavior, dry-run/force semantics correct | stdout, filesystem |
| CLI-03 | `run` | `$LEMMA_CLI run --target . --intent "release confidence" > .lemma/report.json 2>.lemma/run.stderr.log` (+ optional `--seed`, `--max-checks`, `--output`) | JSON report on stdout, progress/warnings on stderr; `.lemma/` state/evidence updated; coverage gaps/holds reported honestly | report, stderr, `.lemma/` |
| CLI-04 | `status` | `$LEMMA_CLI status` | Shows persisted run state/history summary | stdout |
| CLI-05 | `report` | `$LEMMA_CLI report` | Prints latest saved report consistent with run artifacts | stdout |
| CLI-06 | `abort` | Trigger abort during/around active run context if possible | Requests kill; halted run remains halted and forces hold (no auto-resume) | status/report/progress |
| CLI-07 | `prune` | Create history then `$LEMMA_CLI prune --keep-runs <n>` | Prunes safely per retention rules; no corrupt state | `.lemma/` before/after |
| CLI-08 | `doctor` | Run on healthy, missing, and intentionally corrupted `.lemma/` | Reports layout/health and typed missing/corrupt errors; preserves corrupt state | stdout/stderr, unchanged corrupt files |
| CLI-09 | `verify-evidence` | `$LEMMA_CLI verify-evidence --run-id <id>` on valid and tampered evidence | Valid passes; tamper/missing/hash mismatch detected | stdout/exit code |
| CLI-10 | `sarif` | `$LEMMA_CLI sarif` after run | Exports SARIF from latest report | SARIF file/content |
| CLI-11 | `junit` | `$LEMMA_CLI junit` after run | Exports JUnit XML from latest report | XML file/content |
| CLI-12 | `sign-report` | `$LEMMA_CLI sign-report` (per supported options) | Produces report signature artifact | signature output/files |
| CLI-13 | `verify-report` | `$LEMMA_CLI verify-report` for valid and tampered cases | Valid signature verifies; tampered/invalid fails | stdout/exit code |
| CLI-14 | `personas` | `personas list`, `personas lint`, `personas scaffold` | Persona operations work; lint/scaffold outputs actionable | stdout/files |
| CLI-15 | `suppress` | Add/list/remove suppressions (supported forms) | Suppressions managed correctly; report behavior consistent with contract | stdout/store/report |
| CLI-16 | `suppressions` | Use alias commands | Same behavior as `suppress` | stdout/store |
| CLI-17 | `calibrate` | `$LEMMA_CLI calibrate` with fixtures | Calibration runs and emits report | stdout/report |
| CLI-18 | `migrate-state` | Prepare legacy `.harness/` then run command | Safe copy/migration to `.lemma/` with documented behavior; no unintended data loss | `.harness/` + `.lemma/` |
| CLI-19 | `settings` | View/update settings (supported options) | Schema-validated settings read/write behavior | stdout, `.lemma/settings.json` |
| CLI-20 | `more` | Continue run with deferred checks | Continues same run or returns clear typed/semantic errors | progress/report |
| CLI-21 | `auto` | Run bounded auto loop; test resume/approval-decline | Bounded, approval-gated mutations, resumable as designed | artifacts/logs |
| CLI-22 | `browser` | `$LEMMA_CLI browser <url>` / checks subset | Focused browser inspection/evidence or honest blocked degradation | evidence/report |
| CLI-23 | `human` | Record human context/answers for run | Context persisted; material unanswered questions hold decision | stored context/report |
| CLI-24 | `generate` | Generate intents from supported sources | Planned intents generated without execution | intent artifacts |
| CLI-25 | `tests` | `create/import/convert/repair/bake/list/delete` flows | Durable intent lifecycle operations and validation work | files/state |
| CLI-26 | `upgrade` | Dry-run and approval-gated apply | Preview before mutation; no unintended changes on decline | diffs/artifacts |
| CLI-27 | `review` | Independent run review with distinct reviewer | Explicit review notes attached; decision not silently overridden | review artifacts/report |
| CLI-28 | `hunt` | Run bounded bug-hunting workflow in safe target | Bounded/stateful execution with evidence-backed outputs or coverage gaps | `.lemma/` artifacts |
| CLI-29 | `continuous` | Run `pr|nightly|scheduled` modes | Durable bounded history and summaries/markers as applicable; typed handling of corrupt history | `.lemma/continuous/*` |
| CLI-30 | `forever` | Start controlled/bounded continuous workflow | Durable checkpoints/live mission behavior; controllable/stoppable; no state corruption | mission/checkpoints |
| CLI-31 | `demo` | Generate disposable demo project in temp path | Demo scaffold created without polluting target repo | generated path |
| CLI-32 | `confidence` | `confidence init` (and supported subcommands) | `.confidence/` workspace managed as documented | `.confidence/` |
| CLI-33 | `feedback` | Run feedback commands; test `feedback serve` only with explicit intent | Safe default behavior; service starts only when explicitly requested | stdout/state |
| CLI-34 | `pro` | `pro confidence|security|performance|privacy`, `pro proof`, `pro inventory`, `pro history`, `pro eval` | Unlicensed: clean Pro-unavailable refusal/no partial execution; licensed/configured: workflows run and emit artifacts | stdout, `.lemma/pro/*` |
| CLI-35 | `demo` + `run` quick smoke (optional) | Create demo project then run Lemma against it | Useful baseline sanity check for new installs | demo dir, report/state |

---

## 6. Cross-cutting end-to-end checks

| ID | Scenario | Steps | Expected result |
|---|---|---|---|
| XC-01 | Stdout/stderr contract | Run `run/status/report` and pipe stdout separately | stdout is parseable/machine output (JSON where applicable); progress/warnings only on stderr |
| XC-02 | Coverage-gap honesty | Exercise unavailable browser/runtime/tool/refusal paths | blocked/skipped/errored/refused recorded as coverage gaps; never pass; no confidence inflation |
| XC-03 | Halt/hold semantics | Abort/kill flow | Halted runs persist and force hold; no automatic resume |
| XC-04 | Determinism (where supported) | Repeat with same inputs/seed/frozen clock | Stable/comparable outputs except documented volatile fields |
| XC-05 | Redaction | Use synthetic secret-like values in inputs | No secrets in `.lemma/`, evidence, reports, logs, or stdout |
| XC-06 | Evidence integrity | Tamper with evidence artifact and run `verify-evidence` | Verification detects mismatch/tamper |
| XC-07 | Continuation safety | `run --resume`, `/lemma-more`, `/lemma-auto` resume | No rerun of completed work; fingerprint/compatibility checks enforced |
| XC-08 | Capability honesty in OpenCode | Use commands requiring unavailable dashboard/pro/browser/background capabilities | Explicit, user-visible limitation/degradation; no silent emulation |

---

## 7. Suggested execution order
1. **INS-01 to INS-06** (simple install + OpenCode discovery)
2. **SL-01 to SL-04, SL-08 to SL-11** (core slash command smoke)
3. **CLI-03 to CLI-07, CLI-09 to CLI-13** (core run/report/evidence lifecycle)
4. **SL-20, CLI-22, XC-01 to XC-08** (browser + cross-cutting guarantees)
5. **SL-18, SL-19, SL-21 to SL-25, CLI-20 to CLI-29** (continuations, generation, review, workflows)
6. **SL-05 to SL-07, SL-12 to SL-17, CLI-30 to CLI-34** (dashboard/pro/entitlement-gated and auxiliary commands)
7. Re-run **CLI-08, CLI-18** on dedicated fixtures/copies

---

## 8. Exit criteria and reporting

### 8.1 Exit criteria
- All applicable slash commands and CLI commands executed for the environment.
- Any non-run case marked **Blocked** with reason (missing runtime, entitlement, service, or fixture), not Pass/Fail.
- No unresolved **Fail** without a defect record.
- Degraded behavior accepted only when capability-honest and consistent with Lemma invariants.

### 8.2 Summary report (fill after execution)
- **Build/environment:** Lemma commit, Node/pnpm, OpenCode version, OS
- **Target repo(s):**
- **Commands passed:**
- **Commands degraded-as-expected:** (with reasons)
- **Commands blocked:** (with reasons)
- **Commands failed:** (with defect links/notes)
- **Key artifacts:** report paths, run IDs, evidence dirs, screenshots/transcripts
- **Notable risks/gaps observed:**

---

## 9. Notes for testers
- Prefer disposable copies/branches for mutating commands (`auto`, `upgrade`, `tests`, suppressions/settings).
- Never paste real secrets/tokens into prompts, files, or bug reports; use synthetic values and redact outputs.
- If a command is Pro-gated or environment-dependent, validate the refusal/error path when unavailable and the functional path when available.
- A "blocked/unavailable" result can be correct; correctness means it is reported honestly and does not produce a false pass.

---

## 10. `/lemma-browser` interaction-regression RCA and verification

### 10.1 Root cause found
`/lemma-browser` has two execution paths:

1. **OpenCode command markdown** (`~/.opencode/commands/lemma-browser.md`) — already fixed to call the concrete `browser` CLI entry point.
2. **Agent-loop/catalog path** (`buildCatalogInvocation` → `browserInvocation`) — was still emitting `run --target <url> --active --active-interactions …`. `lemma run` does not parse those flags and does not run the `browser.steps` check, so no clicks, form fills, toggles, scrolls, or navigation were executed. Some runs also recorded `scoped_checks: []` because an invalid check filter silently disabled all checks.

### 10.2 Fixes
- `browserInvocation` now emits `browser <URL> --crawl --max-pages 25 --timeout-ms 120000`.
- `commandToArgs`/`isAllowedCommand` accept `lemma-browser` (and keep `assay-browser` as a compatibility alias).
- `scopedCheckIds` falls back to all checks when a filter matches none, so a run can never silently have zero checks/interaction evidence.
- The installed `/lemma-browser` command now requires verification of `browser.steps` and `auto-interactions-*` artifacts before reporting success.

### 10.3 Verification steps (rerunnable)
```bash
# 1. Catalog/agent-loop path emits the browser subcommand
node --input-type=module - <<'NODE'
import { buildCatalogInvocation } from './packages/agent/dist/index.js';
console.log(buildCatalogInvocation('lemma-browser', 'https://testradius.dev', '/personas').invocation.args[0]);
NODE
# expected: browser

# 2. CLI executes the interaction regression
lemma browser https://testradius.dev --max-pages 1 --timeout-ms 15000 > /tmp/lemma-browser.json 2>/dev/null
RUN_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/lemma-browser.json','utf8')).run_id)")
node -e "const r=JSON.parse(require('fs').readFileSync('/tmp/lemma-browser.json','utf8')); const s=r.observations.find(o=>o.check_id==='browser.steps'); console.log(s.status, s.evidence.refs.length)"
ls .lemma/evidence/$RUN_ID | grep 'auto-interactions'
# expected: browser.steps observation present with 30+ evidence refs; auto-interactions plan/results/step screenshots exist
```
