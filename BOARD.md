# Lemma Delivery Board

**Project:** `lemma` — deterministic release confidence as a plugin for OpenCode,
Claude Code, Codex, Antigravity, and Cursor.
**Source of record:** `../assay` (`quality-harness`) at 2026-11-14.
**Mode:** feature-parity migration plus a host-adapter layer. No greenfield scope
beyond what is required to ship the same product in TypeScript.

## How to Use

This board is the shared contract between the operator and any coding agent
working on `lemma`.

- Pick the lowest-numbered task whose status is `Ready` and whose dependencies
  are all `Done`. Do not start a blocked task.
- Work one task per change. Update the task card, this board, the parity
  inventory, and the test suite in the same change.
- A task moves to `In Progress` only when an agent has claimed it and can state
  the exact acceptance test it is about to satisfy.
- `Points` use the Fibonacci set `1, 2, 3, 5, 8`. If a task needs more than `8`,
  split it; do not stretch the estimate.
- `Priority` is `P0` (release or parity blocker), `P1` (required for the first
  shippable release), `P2` (valuable, not urgent), or `P3` (deferred).
- Every task keeps a valid dependency chain: a task may depend only on a
  lower-numbered task, and no cycle is allowed.
- Only the first unblocked tasks carry detailed cards. A backlog task is scoped
  by its outcome and dependency; its full acceptance card is written when it is
  promoted to `Ready`. The parity inventory already names the evidence expected
  for every task.
- A task is not done until its acceptance criteria pass in a command another
  agent can rerun and the parity inventory rows it owns are updated.

## Current Focus

**Build the TypeScript foundation and prove parity on the deterministic core
before porting the plugin surface.**

The critical path is:

```text
LEM-001 -> LEM-003 -> LEM-004 -> LEM-007 -> LEM-010
        -> LEM-011 -> LEM-014 -> LEM-015 -> LEM-020 -> LEM-026
        -> LEM-083 -> LEM-086 -> LEM-098 -> LEM-100
        -> LEM-101 (OpenCode) and LEM-102 (Claude Code)
        -> LEM-141 -> LEM-143 -> LEM-144 -> LEM-147 -> LEM-142
        -> LEM-148 -> LEM-149 -> LEM-154 -> LEM-151 -> LEM-150
        -> LEM-153 -> LEM-145 -> LEM-146 -> LEM-152 -> LEM-155
        -> LEM-109 / LEM-110 -> LEM-139 (parity sign-off)
```

Why this order:

1. A monorepo with quality gates prevents five inconsistent host packages.
2. Schemas and determinism must land before the orchestrator, or parity becomes
   a rewrite instead of a port.
3. The CLI plus agent loop must be host-neutral before any adapter is written.
4. OpenCode and Claude Code are first because they are the two install targets
   named as the immediate shipping goal; Codex, Antigravity, and Cursor follow
   through the same conformance kit.
5. CARBON-parity UX (G2.5) sits between the deterministic core and host adapters
   because conversational, visual, and bug-hunting behaviour must exist before
   adapter conformance is meaningful. Lemma is only “as good as CARBON” once
   these tasks are done, not before.

**Parity rule:** until `LEM-139`, `assay` is the oracle. A lemma run against the
same fixture and options must produce the same normalized report. Any intentional
divergence needs an ADR and a Decision Log row.

## Migration Gates

| Gate | Name | Exit criteria | Tasks |
| --- | --- | --- | --- |
| G0 | Foundation | Monorepo, schemas, determinism, errors, redaction, atomic state, and golden parity harness exist | LEM-001–LEM-010 |
| G1 | Core parity | A static `lemma run` matches `assay` for the sample fixture, including resume, kill, evidence, scoring, and report | LEM-011–LEM-026 |
| G2 | Evidence parity | Static, browser, persona, plugin, policy, export, and suppression behavior match the parity corpus | LEM-027–LEM-082 |
| G2.5 | CARBON-parity UX | HTML export, dashboard (live view, screenshots, journey maps, Release Brief, settings), bug-hunting workflow, and extended dynamic a11y all pass acceptance tests; parity inventory rows updated | LEM-141–LEM-155 |
| G3 | Agent parity | CLI, agent loop, command catalog, browser prompt, and Jira context match the OpenCode product behavior | LEM-083–LEM-097 |
| G4 | Host surface | One shared adapter contract, five adapters, installer, and conformance kit; OpenCode and Claude Code pass E2E | LEM-098–LEM-112 |
| G5 | Commercial parity | Metering, auth, quota, ledger, signup, billing, queue, and retention match assay | LEM-113–LEM-122 |
| G6 | Release | Hardening, packaging, docs, migration guide, and signed parity audit | LEM-123–LEM-140 |

## Delivery Phases

| Phase | Focus | Tasks | Outcome |
| --- | --- | --- | --- |
| A | Foundation | LEM-001–LEM-010 | A typed, tested, releasable monorepo skeleton |
| B | Deterministic core | LEM-011–LEM-026 | A static run that matches assay |
| C | Evidence surface | LEM-027–LEM-082 | Static checks, personas, browser, plugins, exports |
| D | Agent surface | LEM-083–LEM-097 | CLI, agent loop, 59-command catalog, Jira context |
| E | Host adapters | LEM-098–LEM-112 | OpenCode, Claude Code, Codex, Antigravity, Cursor |
| F | Commercial parity | LEM-113–LEM-122 | Metering, auth, quota, ledger, billing, queue |
| G | Release | LEM-123–LEM-140 | Hardened, documented, signed, published |
| H | CARBON-parity UX | LEM-141–LEM-155 | Conversational manager, bug-hunting workflow, background checks, demo, slash commands, local dashboard, HTML export, screenshots, journey maps, Release Brief, settings UI, dynamic a11y, native MCP server, optional analytics, Pro navigation |

---

## Backlog

### E1: Platform Foundation

**Outcome:** One TypeScript monorepo with strict quality gates, versioned
contracts, deterministic primitives, and a repeatable way to prove behavioral
parity with assay.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-001 | Initialize the pnpm/TypeScript monorepo and quality gates | P0 | 3 | None | Done |
| LEM-002 | Publish the machine-readable assay parity manifest and check | P0 | 3 | None | Done |
| LEM-003 | Ratify the architecture, package graph, and adapter contract | P0 | 3 | None | Done |
| LEM-004 | Define versioned zod schemas and inferred core types | P0 | 5 | LEM-003 | Done |
| LEM-005 | Build the assay↔lemma golden parity harness | P0 | 5 | LEM-001, LEM-002, LEM-004 | Done |
| LEM-006 | Port deterministic clock, entropy, and seeded id providers | P0 | 3 | LEM-004 | Done |
| LEM-007 | Port the typed error model and exit-code contract | P0 | 2 | LEM-004 | Done |
| LEM-008 | Port the redaction engine and synthetic corpus | P0 | 3 | LEM-004 | Done |
| LEM-009 | Decide package naming, release flow, and consumer contracts | P1 | 3 | LEM-001, LEM-003 | Done |
| LEM-010 | Port atomic state, JSON, and file-lock primitives | P0 | 5 | LEM-001, LEM-007 | Done |

### E2: Deterministic Core Engine

**Outcome:** A reproducible five-phase state machine with atomic state, hashed
evidence, resume, kill behavior, and a report that matches assay for the same
inputs.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-011 | Port progress state, events, history, retention, and kill file | P0 | 5 | LEM-010 | Done |
| LEM-012 | Port the versioned workflow loader and phase invariant | P0 | 5 | LEM-004, LEM-007 | Done |
| LEM-013 | Port domain models, findings, and normalization | P0 | 5 | LEM-004 | Done |
| LEM-014 | Port the check catalog, registry, and intent planning | P0 | 5 | LEM-013 | Done |
| LEM-015 | Port the five-phase orchestrator and budget | P0 | 8 | LEM-011, LEM-012, LEM-014 | Done |
| LEM-016 | Port the hashed evidence store and checkpoint manifest | P0 | 5 | LEM-010 | Done |
| LEM-017 | Port evidence signing, verification, and tamper hold | P1 | 3 | LEM-016 | Done |
| LEM-018 | Port `weighted-coverage-v1` scoring | P0 | 5 | LEM-013 | Done |
| LEM-019 | Port versioned policy files and gate evaluation | P1 | 3 | LEM-018 | Done |
| LEM-020 | Port the report builder and JSON Schema validation | P0 | 5 | LEM-013, LEM-018 | Done |
| LEM-021 | Port resume, crash safety, and registry fingerprint | P0 | 5 | LEM-011, LEM-015 | Done |
| LEM-022 | Port seeded resume and id-sequence continuity | P2 | 3 | LEM-006, LEM-021 | Done |
| LEM-023 | Port run history, retention, and prune | P2 | 3 | LEM-011 | Done |
| LEM-024 | Port risk analysis | P1 | 3 | LEM-013 | Done |
| LEM-025 | Port the scenario step planner and runner | P1 | 5 | LEM-024 | Done |
| LEM-026 | Build the orchestrator conformance suite | P0 | 5 | LEM-015, LEM-016, LEM-018, LEM-020, LEM-021 | Done |

### E3: Static Analysis and Category Coverage

**Outcome:** Source inspection is git-aware, scoped, precise, redacted, and
covers every assay category command with an owned check or a documented no-op.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-027 | Port source inventory and git-aware tracked/ignored scanning | P0 | 5 | LEM-013 | Done |
| LEM-028 | Port `.harnessignore`-equivalent scoping | P1 | 3 | LEM-027 | Done |
| LEM-029 | Port inventory, tests, CI, and dependency checks | P0 | 5 | LEM-014, LEM-027 | Done |
| LEM-030 | Port the accessibility markup scan | P1 | 3 | LEM-027 | Done |
| LEM-031 | Port secret scanning and precision rules | P0 | 5 | LEM-027 | Done |
| LEM-032 | Port unsafe-code rules | P0 | 3 | LEM-027 | Done |
| LEM-033 | Port baseline category checks (test/functionality/browser/issues/demo/more) | P1 | 5 | LEM-014, LEM-027 | Done |
| LEM-034 | Port full-assessment markers | P1 | 3 | LEM-027 | Done |
| LEM-035 | Port CI root-scoping precision | P2 | 2 | LEM-029 | Done |
| LEM-036 | Port risk tracked-file parity | P2 | 3 | LEM-024, LEM-027 | Done |
| LEM-037 | Cover the remaining 50+ category commands with owned checks or documented no-ops | P1 | 8 | LEM-033 | Done |
| LEM-038 | Port the sample-repo, demo-web, and static fixtures | P1 | 3 | LEM-027 | Done |
| LEM-039 | Build the static precision and recall corpus | P1 | 5 | LEM-031, LEM-032 | Done |
| LEM-040 | Verify static finding-to-evidence linkage and report totals | P1 | 3 | LEM-016, LEM-020 | Done |

### E4: Specialist Persona Layer

**Outcome:** Personas are data contracts, not prompt fragments. Ownership is
disjoint, invalid findings are quarantined, and a blocked check can never become
a pass.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-041 | Port the persona frontmatter parser | P0 | 3 | LEM-013 | Done |
| LEM-042 | Port output and blocker schema validation | P0 | 5 | LEM-041 | Done |
| LEM-043 | Port the functional, security, and accessibility contracts | P0 | 3 | LEM-041, LEM-042 | Done |
| LEM-044 | Port ownership derivation and disjointness enforcement | P0 | 3 | LEM-014, LEM-041 | Done |
| LEM-045 | Port invalid-finding quarantine and degraded streaks | P0 | 5 | LEM-013, LEM-042 | Done |
| LEM-046 | Port structured blocker and refusal records | P0 | 5 | LEM-042 | Done |
| LEM-047 | Port `personas lint` | P1 | 3 | LEM-041, LEM-044 | Done |
| LEM-048 | Port `personas scaffold` | P2 | 3 | LEM-047 | Done |
| LEM-049 | Port tool capability enforcement and persona conformance tests | P1 | 3 | LEM-043, LEM-044 | Done |

### E5: Browser and Operate Layer

**Outcome:** Live verification is real browser evidence when Chromium is
available, an explicit blocked coverage gap when it is not, and never a static
scan wearing a browser label.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-050 | Add the optional Playwright runtime and blocked degradation | P0 | 5 | LEM-013 | Done |
| LEM-051 | Port load, console, network, content, and link checks | P0 | 8 | LEM-050 | Done |
| LEM-052 | Port the browser security check | P1 | 3 | LEM-050 | Done |
| LEM-053 | Port the browser accessibility check | P1 | 3 | LEM-050 | Done |
| LEM-054 | Port the bounded same-origin crawl | P1 | 8 | LEM-051 | Done |
| LEM-055 | Port the responsive/mobile pack (overflow, focus order) | P1 | 5 | LEM-051 | Done |
| LEM-056 | Port authenticated storage-state injection | P1 | 3 | LEM-050 | Done |
| LEM-057 | Port HAR, trace, and video capture with redaction | P2 | 5 | LEM-051 | Done |
| LEM-058 | Port scenario-file execution and `browser.steps` | P1 | 5 | LEM-051 | Done |
| LEM-059 | Port SSRF-safe target validation and allowlists | P0 | 5 | LEM-010 | Done |
| LEM-060 | Port browser fixtures and the CI smoke/blocked legs | P1 | 3 | LEM-050, LEM-051 | Done |
| LEM-061 | Verify browser evidence, manifest, and report linkage | P0 | 3 | LEM-016, LEM-051 | Done |
| LEM-062 | Port viewport and check metadata contracts | P2 | 2 | LEM-051, LEM-055 | Done |
| LEM-063 | Port browser defaults (crawl, mobile, headed, active) | P1 | 3 | LEM-054, LEM-055 | Done |
| LEM-064 | Build the browser regression suite | P1 | 5 | LEM-051, LEM-054, LEM-055, LEM-058 | Done |

### E6: Reporting, Policy, and Exports

**Outcome:** The report is versioned, portable, comparable, signable, and
reconcilable. Suppressions are auditable and never silent.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-065 | Port SARIF export | P1 | 3 | LEM-020 | Done |
| LEM-066 | Port JUnit export | P1 | 3 | LEM-020 | Done |
| LEM-067 | Port report signing and verification | P1 | 3 | LEM-020 | Done |
| LEM-068 | Port run-to-run trend diff | P1 | 3 | LEM-011, LEM-020 | Done |
| LEM-069 | Port baseline suppression with owner and expiry | P1 | 3 | LEM-013 | Done |
| LEM-070 | Port labeled calibration fixtures and `calibrate` | P1 | 3 | LEM-018 | Done |
| LEM-071 | Port `verify-evidence` and the hold-on-tamper behavior | P1 | 3 | LEM-017 | Done |
| LEM-072 | Port run-scoped and sink-wide metering summaries | P1 | 2 | LEM-020 | Done |
| LEM-073 | Build report-schema compatibility and contract tests | P1 | 3 | LEM-020 | Done |
| LEM-074 | Build policy and calibration regression coverage | P2 | 3 | LEM-019, LEM-070 | Done |

### E7: Plugins and Extensibility

**Outcome:** Teams can add a check without editing the orchestrator. A plugin
that cannot be verified is a blocked gap, never a pass and never a run failure.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-075 | Port the signed plugin registry | P0 | 8 | LEM-014 | Done |
| LEM-076 | Port the plugin context and blocked-failure handling | P0 | 5 | LEM-075 | Done |
| LEM-077 | Port plugin ownership validation | P0 | 3 | LEM-044, LEM-075 | Done |
| LEM-078 | Define the TypeScript plugin authoring API | P1 | 5 | LEM-075, LEM-076 | Done |
| LEM-079 | Port the HMAC trust store and signing helper | P0 | 3 | LEM-075 | Done |
| LEM-080 | Publish the sample plugin and authoring docs | P1 | 3 | LEM-076, LEM-078 | Done |
| LEM-081 | Port resume protection against a changed plugin registry | P2 | 3 | LEM-021, LEM-075 | Done |
| LEM-082 | Build the plugin conformance suite | P1 | 5 | LEM-075, LEM-076, LEM-077 | Done |

### E8: CLI and Agent Core

**Outcome:** One machine-first CLI and one host-neutral bounded agent loop serve
every host. The command catalog, context protocol, and Jira flow are preserved.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-083 | Build the CLI shell, JSON-only stdout, and exit codes | P0 | 5 | LEM-007, LEM-015 | Done |
| LEM-084 | Port `run`, `status`, `report`, `abort`, and `prune` | P0 | 5 | LEM-083 | Done |
| LEM-085 | Port persona, export, signing, suppression, calibration, and verify commands | P1 | 5 | LEM-065, LEM-066, LEM-067, LEM-069, LEM-070, LEM-071, LEM-083 | Done |
| LEM-086 | Port the strict-judge agent loop (cap 7, allowlist, dedupe) | P0 | 8 | LEM-083, LEM-084 | Done |
| LEM-087 | Port agent state persistence and in-session resume | P0 | 5 | LEM-010, LEM-086 | Done |
| LEM-088 | Port command argument builders | P0 | 3 | LEM-083 | Done |
| LEM-089 | Port the 59-command catalog and intent mapping | P1 | 5 | LEM-088 | Done |
| LEM-090 | Port the browser agent prompt and invariants | P1 | 3 | LEM-088 | Done |
| LEM-091 | Port the context protocol and question flow | P1 | 5 | LEM-086 | Backlog |
| LEM-092 | Port the native Jira form tool, ADF flattening, and redaction | P1 | 5 | LEM-008, LEM-091 | Backlog |
| LEM-093 | Port MCP resource discovery and secret references | P2 | 3 | LEM-091 | Backlog |
| LEM-094 | Port progress, run summaries, and final narrative | P1 | 3 | LEM-086 | Backlog |
| LEM-095 | Build command-builder and catalog parity tests | P1 | 5 | LEM-086, LEM-088, LEM-089 | Backlog |
| LEM-096 | Build agent-loop and prompt-contract tests | P1 | 3 | LEM-090, LEM-091 | Backlog |
| LEM-097 | Publish CLI and agent behavior docs | P2 | 3 | LEM-083, LEM-086 | Backlog |

### E9: Adapter SDK and Host Integrations

**Outcome:** OpenCode, Claude Code, Codex, Antigravity, and Cursor share one
adapter contract. Each host is installable, capability-honest, and E2E-tested.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-098 | Implement the shared `AgentHost` adapter SDK | P0 | 5 | LEM-003, LEM-083 | Backlog |
| LEM-099 | Implement capability negotiation and graceful degradation | P0 | 5 | LEM-098 | Backlog |
| LEM-100 | Build the adapter conformance kit and fake host | P0 | 5 | LEM-098, LEM-099 | Backlog |
| LEM-101 | Build the OpenCode adapter | P0 | 8 | LEM-086, LEM-088, LEM-092, LEM-098, LEM-099, LEM-100 | Backlog |
| LEM-102 | Build the Claude Code adapter | P0 | 8 | LEM-086, LEM-088, LEM-098, LEM-099, LEM-100 | Backlog |
| LEM-103 | Build the Codex adapter | P1 | 5 | LEM-086, LEM-088, LEM-098, LEM-099, LEM-100 | Backlog |
| LEM-104 | Build the Antigravity adapter | P1 | 5 | LEM-086, LEM-088, LEM-098, LEM-099, LEM-100 | Backlog |
| LEM-105 | Build the Cursor adapter | P1 | 5 | LEM-086, LEM-088, LEM-098, LEM-099, LEM-100 | Backlog |
| LEM-106 | Create the shared prompt, skill, and command templates | P1 | 5 | LEM-089, LEM-090, LEM-091 | Backlog |
| LEM-107 | Build the `lemma install <host>` installer | P1 | 5 | LEM-100, LEM-101 | Backlog |
| LEM-108 | Produce per-host packaging manifests | P1 | 5 | LEM-101, LEM-102, LEM-103, LEM-104, LEM-105 | Backlog |
| LEM-109 | Add the OpenCode end-to-end parity suite | P0 | 5 | LEM-101, LEM-106, LEM-107 | Backlog |
| LEM-110 | Add the Claude Code end-to-end suite | P0 | 5 | LEM-102, LEM-106, LEM-107 | Backlog |
| LEM-111 | Add Codex, Antigravity, and Cursor smoke suites | P1 | 5 | LEM-103, LEM-104, LEM-105, LEM-106 | Backlog |
| LEM-112 | Publish the adapter compatibility matrix and docs | P1 | 3 | LEM-108, LEM-109, LEM-110, LEM-111 | Backlog |

### E10: Commercial Parity

**Outcome:** The open-source core stays account-free while the cloud tier
preserves assay's metering, identity, quota, ledger, signup, billing, queue, and
retention contracts.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-113 | Port the frozen metering event contract and local sink | P1 | 5 | LEM-013, LEM-020 | Backlog |
| LEM-114 | Port workspace auth, hashed scoped keys, and audit | P1 | 8 | LEM-013 | Backlog |
| LEM-115 | Port per-action quota enforcement | P1 | 8 | LEM-113, LEM-114 | Backlog |
| LEM-116 | Port the append-only ledger and invoice export | P1 | 8 | LEM-113, LEM-115 | Backlog |
| LEM-117 | Port self-serve signup and signed entitlements | P1 | 5 | LEM-114, LEM-115 | Backlog |
| LEM-118 | Port feature-gated metered billing and kill switch | P2 | 8 | LEM-116, LEM-117 | Backlog |
| LEM-119 | Port the tenant queue and isolation | P1 | 8 | LEM-015, LEM-114, LEM-115 | Backlog |
| LEM-120 | Port tenant retention, export, and deletion | P1 | 5 | LEM-119 | Backlog |
| LEM-121 | Port billing and entitlement regression coverage | P2 | 3 | LEM-118 | Backlog |
| LEM-122 | Enforce cloud package boundaries and optional extras | P1 | 3 | LEM-113–LEM-120 | Backlog |

### E11: Hardening, Privacy, and Reliability

**Outcome:** Sensitive data, hostile targets, partial failures, and tampered
artifacts cannot produce a false release signal.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-123 | Port the redaction regression corpus and artifact scan | P0 | 3 | LEM-008 | Backlog |
| LEM-124 | Port the evidence-tamper regression suite | P1 | 3 | LEM-017 | Backlog |
| LEM-125 | Port the SSRF regression suite | P0 | 3 | LEM-059 | Backlog |
| LEM-126 | Port state, evidence, and kill-switch failure injection | P0 | 5 | LEM-011, LEM-016, LEM-017 | Backlog |
| LEM-127 | Prove atomic writes and locks cross-platform | P1 | 5 | LEM-010 | Backlog |
| LEM-128 | Audit untrusted evidence paths and path traversal | P1 | 3 | LEM-016 | Backlog |
| LEM-129 | Audit that no path resumes a halted run | P0 | 3 | LEM-015 | Backlog |
| LEM-130 | Audit dependency and supply-chain posture | P1 | 3 | LEM-009 | Backlog |
| LEM-131 | Set and test performance/scale budgets | P2 | 3 | LEM-026 | Backlog |

### E12: CI, Packaging, Release, and Docs

**Outcome:** A clean checkout installs, tests, builds, publishes, and runs on
every supported host with visible supply-chain evidence.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-132 | Build the CI matrix (Node 20/22, macOS/Linux/Windows) | P0 | 3 | LEM-001, LEM-026 | Backlog |
| LEM-133 | Add browser-enabled and blocked-degradation CI legs | P1 | 3 | LEM-060, LEM-132 | Backlog |
| LEM-134 | Publish signed npm packages with provenance | P1 | 5 | LEM-009, LEM-112 | Backlog |
| LEM-135 | Build core and browser container images | P2 | 3 | LEM-134 | Backlog |
| LEM-136 | Ship the GitHub Action and one marker-based PR comment | P1 | 5 | LEM-020, LEM-084 | Backlog |
| LEM-137 | Reach README and user-doc parity with assay | P1 | 5 | LEM-097, LEM-112 | Backlog |
| LEM-138 | Publish the assay→lemma migration guide and state shim | P1 | 3 | LEM-137 | Backlog |
| LEM-139 | Run the full parity audit and sign off | P0 | 8 | LEM-112, LEM-115, LEM-121, LEM-126, LEM-131, LEM-133, LEM-134, LEM-135, LEM-136, LEM-137, LEM-138 | Backlog |
| LEM-140 | Point assay at lemma and publish the deprecation notice | P2 | 2 | LEM-139 | Backlog |

### E13: Conversational Agent Surface

**Outcome:** One host-neutral, conversational testing experience. A manager persona
plans, explains, and narrates the run in natural language; a dedicated bug-hunting
workflow explores stateful journeys; background checks run quietly; a demo command
makes the tool tryable; slash commands work natively in-chat.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-141 | Build the conversational test manager persona | P1 | 8 | LEM-086, LEM-091, LEM-094 | Backlog |
| LEM-148 | Build the dedicated bug-hunting workflow (stateful/persona-based exploration) | P1 | 8 | LEM-044, LEM-058, LEM-089 | Backlog |
| LEM-150 | Build the background quick-check supervisor | P2 | 5 | LEM-084, LEM-086 | Backlog |
| LEM-153 | Build the user-facing demo project generator (`lemma demo`) | P2 | 3 | LEM-038, LEM-083 | Backlog |
| LEM-154 | Verify and complete the in-chat slash-command interface | P1 | 5 | LEM-089, LEM-091, LEM-106 | Backlog |

### E14: Visual Evidence and Reporting Surface

**Outcome:** Findings are visible, shareable, and human-readable. A local dashboard
serves a live investigation view, screenshots linked to checks, a journey map, a
Release Brief, and a protected settings page. HTML export is self-contained and
portable. Dynamic accessibility checks cover keyboard and live contrast.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-142 | Build portable self-contained HTML report export | P1 | 5 | LEM-020 | Backlog |
| LEM-143 | Build the local visual evidence dashboard (shell + live investigation view) | P1 | 5 | LEM-016, LEM-020, LEM-061 | Backlog |
| LEM-144 | Capture and display screenshots for browser check evidence | P1 | 3 | LEM-051, LEM-143 | Backlog |
| LEM-145 | Add Release Brief stakeholder summary to the dashboard | P2 | 3 | LEM-020, LEM-143 | Backlog |
| LEM-146 | Add interactive settings UI to the dashboard | P2 | 3 | LEM-143 | Backlog |
| LEM-147 | Build journey map visualization | P1 | 5 | LEM-058, LEM-143 | Backlog |
| LEM-149 | Extend dynamic accessibility testing (keyboard traversal, live contrast, screen-reader hints) | P2 | 5 | LEM-053, LEM-055 | Backlog |

### E15: MCP Tool Server

**Outcome:** The testing engine is a first-class MCP tool server, not only an
adapter-level bridge. Any MCP-compatible coding agent can start, update, report,
and query a lemma run through native tools.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-151 | Build the native MCP server exposing testing tools | P1 | 8 | LEM-083, LEM-086, LEM-098 | Backlog |

### E16: Commercial and UX Extras

**Outcome:** Optional, user-controlled extras that do not block the core release:
anonymous usage analytics with a clear opt-out and an in-product Pro edition
navigation page.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-152 | Add optional anonymous usage analytics with opt-out | P2 | 3 | LEM-083 | Backlog |
| LEM-155 | Add Pro edition navigation and informational page | P3 | 2 | LEM-143 | Backlog |
---

## Ready / Sprint 0 — Foundation

The cards below are the first executable slice. `LEM-002`–`LEM-003` are Ready;
`LEM-001` is Done. `LEM-004`–`LEM-010` are detailed now so the sprint path is
explicit; they remain `Backlog` until their dependencies are `Done`.

### LEM-001 — Initialize the pnpm/TypeScript monorepo and quality gates

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 3
- **Depends on:** None
- **Status:** Done
- **Claimed:** 2026-11-14 — acceptance test:
  `pnpm install && pnpm lint && pnpm typecheck && pnpm build && pnpm test`.
- **Description:** Create the repository skeleton that every later task builds
  on. Use pnpm workspaces, TypeScript strict mode, ESM, Node.js 20+, tsup (or an
  equivalent zero-config bundler), vitest, ESLint, Prettier, Changesets, and a
  GitHub Actions CI workflow. Create empty package shells matching
  `docs/architecture.md`.
- **Acceptance Criteria:**
  - `pnpm install` succeeds from a clean clone with a committed lockfile.
  - `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` each exit 0 on
    the skeleton.
  - Packages exist for `core`, `browser`, `cli`, `agent`, `cloud`, `personas`,
    and `adapters/{opencode,claude-code,codex,antigravity,cursor}`; each has a
    `package.json`, `tsconfig.json`, and `src/index.ts`.
  - TypeScript is `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
    and `verbatimModuleSyntax`; ESM only.
  - CI runs install/lint/typecheck/build/test on Node 20 and 22.
  - `LICENSE`, `CONTRIBUTING.md`, `.editorconfig`, `.gitignore`, and
    `.changeset/config.json` are present.
  - `@lemma/core` has no workspace dependency on any other lemma package.
- **Verification:** `pnpm install && pnpm lint && pnpm typecheck && pnpm build && pnpm test` — passed locally (2026-11-14): install ok (pnpm lockfile), lint 0, typecheck 0, build 0 (11 packages), test 14/14 passed (1 file).
- **Evidence:** `packages/*` + `packages/adapters/*` shells with manifests/tsconfig/src; `.github/workflows/ci.yml` matrix Node 20/22; root TS strict flags in `tsconfig.base.json`; `LICENSE`, `CONTRIBUTING.md`, `.editorconfig`, `.gitignore`, `.changeset/config.json`; `@lemma/core/package.json` has no workspace dependencies. Local tree/command verification recorded in this change. CI run URL pending first remote push.

### LEM-002 — Publish the machine-readable assay parity manifest and check

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 3
- **Depends on:** None
- **Status:** Done
- **Claimed:** 2026-11-14 — acceptance test:
  `pnpm parity:check` (exit 0 on complete inventory, nonzero on a deliberately removed owner).
- **Description:** Turn `docs/parity/assay-feature-inventory.md` into a
  machine-readable manifest and a check that fails when an assay asset has no
  owner task. The manifest is the completeness contract for the migration.
- **Acceptance Criteria:**
  - `docs/parity/assay.manifest.json` lists every assay module, CLI command,
    plugin command, persona, check id, schema, fixture, test file, and release
    asset with `source`, `kind`, `owner_tasks`, and `status`.
  - Every entry has at least one owner task that exists in `BOARD.md`.
  - `pnpm parity:check` fails on an unmapped source asset, an unknown task id,
    or a missing task id.
  - The check runs in CI and prints a coverage summary by asset kind.
  - The Markdown inventory and the manifest cannot drift: a test compares the
    two lists.
- **Verification:** `pnpm parity:check` — passed (exit 0) with coverage summary (281 entries across 10 kinds). Deliberate-owner-removal check exits nonzero (`FAIL: missing owner task...`) via `--manifest` on a broken copy.
- **Evidence:** `docs/parity/assay.manifest.json`, `scripts/parity/check.mjs`, `packages/core/test/parity.test.ts` (manifest/inventory drift + broken-owner failure), CI updated to run `pnpm parity:check`. Local commands: `pnpm lint`, `pnpm test`, `pnpm parity:check` passed (2026-11-14).

### LEM-003 — Ratify the architecture, package graph, and adapter contract

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 3
- **Depends on:** None
- **Status:** Done
- **Claimed:** 2026-11-14 — acceptance test: `pnpm typecheck` plus the dependency-direction test.
- **Description:** Review and ratify `docs/architecture.md` before code appears.
  Lock the dependency direction, the `AgentHost` interface, the capability
  matrix, the degradation rules, and the optional-dependency policy.
- **Acceptance Criteria:**
  - `docs/architecture.md` contains the package graph, module map,
    `AgentHost`/`HostCapabilities` interfaces, capability matrix, and degradation
    table.
  - An ADR records the choice of TypeScript/ESM, pnpm workspaces, zod for
    contracts, and optional Playwright/cloud subpaths.
  - The adapter package that owns each host is named, and the first two hosts to
    ship (OpenCode, Claude Code) are explicit.
  - A dependency-direction test or lint rule enforces that `core` imports no
    adapter, CLI, browser, cloud, or host SDK package.
  - The operator signs off in the Decision Log.
- **Verification:** `pnpm typecheck` — exit 0. Dependency-direction test — `packages/core/test/dependency-direction.test.ts` passed (forbids `@lemma/core` source imports of agent/cli/browser/cloud/adapters/host SDKs/Playwright).
- **Evidence:** `docs/architecture.md` (ratified; package graph, core module map, `AgentHost`/`HostCapabilities`/`CommandDescriptor` interfaces, capability matrix, degradation rules, explicit adapter ownership with OpenCode+Claude Code first ship), `docs/adr/0001-typescript-monorepo-and-contracts.md`, `packages/core/test/dependency-direction.test.ts`, Decision Log DL11 (operator sign-off). Local: `pnpm typecheck` and `pnpm test` passed (2026-11-14).

### LEM-004 — Define versioned zod schemas and inferred core types

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-003
- **Status:** Done
- **Claimed:** 2026-11-14 — acceptance test: `pnpm test --filter @lemma/core -- schemas`.
- **Description:** Port assay's dataclasses and JSON Schemas into zod-first
  contracts. Export inferred TypeScript types and generated JSON Schemas.
- **Acceptance Criteria:**
  - Zod schemas exist for report v1, state/progress, evidence manifest, persona
    contract, plugin definition, policy, metering envelope and event types,
    quota plan, price book, entitlement, queue job, billing record, and retention
    policy.
  - `lemma.report/v1` accepts a completed, halted, and failed assay report after
    volatile fields are normalized.
  - JSON Schemas are generated into `schemas/` and match the committed files.
  - Public types are inferred from schemas; no hand-written duplicate interface.
  - Contract tests reject removed/typed-wrong fields and allow additive optional
    fields.
- **Verification:** Schema contract tests passed: `pnpm exec vitest run packages/core/test/schemas` (5 tests) and `pnpm --filter @lemma/core test -- schemas` (core suite incl. schemas passed). `pnpm --filter @lemma/core typecheck`/`build`/`lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/schemas/*` (zod + inferred exports), `scripts/schemas/generate.ts`, committed `schemas/**` (23 files, including report/state/evidence/persona/plugin/policy/metering/cloud contracts), `packages/core/test/schemas/schemas.test.ts` (assay report compatibility completed/halted/failed, generated-vs-committed parity, removed/typed-wrong rejection, additive optional acceptance). Commit/remote recorded in completion summary.

### LEM-005 — Build the assay↔lemma golden parity harness

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-001, LEM-002, LEM-004
- **Status:** Done
- **Claimed:** 2026-11-14 — acceptance test: `pnpm test:parity`.
- **Description:** Compare the Python oracle and the TypeScript port on the same
  fixture and options. Normalize run ids, timestamps, absolute paths, and
  platform-specific separators, then diff the report body.
- **Acceptance Criteria:**
  - `pnpm test:parity` runs both implementations against
    `examples/sample-repo`.
  - Normalization removes only documented volatile fields; it never hides a
    finding, check, weight, score, decision, blocker, or coverage count.
  - A seeded/frozen-clock pair produces a zero diff.
  - The harness reports a field-level diff and exits nonzero on drift.
  - Baselines exist for completed, halted, and browser-blocked runs.
  - CI runs parity against the pinned assay commit.
- **Verification:** `pnpm test:parity` — **PASS** (oracle vs committed baselines, seeded/frozen zero-diff pairs for completed/halted/browser-blocked, normalization protection and diff-engine self-check; lemma runner integration point ready via `LEMMA_PARITY_CMD`).
- **Evidence:** `scripts/parity/harness.mjs`, `scripts/parity/README.md` (documented normalization/volatile fields), `docs/parity/oracle.json` (pinned assay commit `c3691d7f044edb53931a82c3ddf0c297b745e000`, python, fixture, deterministic seed/clock), `docs/parity/baselines/{completed,halted,browser-blocked}.json`, `examples/sample-repo/` fixture, `package.json` (`test:parity`), CI updated to checkout pinned assay and run `pnpm test:parity`. Local: `pnpm lint`, `pnpm test`, `pnpm test:parity` passed (2026-11-14). CI run URL pending remote push.

### LEM-006 — Port deterministic clock, entropy, and seeded id providers

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-004
- **Status:** Done
- **Claimed:** 2026-11-14 — acceptance test: `pnpm test --filter @lemma/core -- determinism`.
- **Description:** Recreate assay's injectable clock and entropy providers,
  including frozen clock, seeded id sequences, and the report `determinism`
  object.
- **Acceptance Criteria:**
  - `Clock`, `Entropy`, `RealClock`, `FrozenClock`, and `SeededEntropy`
    interfaces match assay semantics.
  - Two runs with the same seed and frozen clock produce byte-identical findings,
    ids, weights, phase detail, and confidence breakdown.
  - Production defaults use real UTC and cryptographically random ids.
  - `--generated-at` overrides only the report field, not run timestamps.
  - Invalid seed/clock combinations raise a typed error.
- **Verification:** `pnpm --filter @lemma/core test -- determinism` — **PASS** (5 tests; core suite 28/28 passed). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/determinism.ts` (`Clock`/`Entropy`/`RealClock`/`FrozenClock`/`SeededEntropy`, `makeDeterminism`, active context helpers, deterministic `now`/`newId`/`runId`), `packages/core/test/determinism/determinism.test.ts` (seeded/frozen byte-identical outputs, real-UTC/random defaults, generated-at report-only override behavior, typed `HarnessError` validation). Commit/remote recorded in completion summary.

### LEM-007 — Port the typed error model and exit-code contract

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 2
- **Depends on:** LEM-004
- **Status:** Done
- **Claimed:** 2026-11-14 — acceptance test: `pnpm test --filter @lemma/core -- errors`.
- **Description:** Recreate assay's typed errors and the CLI exit-code contract
  so every failure is machine-readable and never leaks a stack trace to stdout.
- **Acceptance Criteria:**
  - Typed errors exist for harness, workflow, state, persona, plugin, policy,
    auth, quota, billing, queue, SSRF, and redaction failures.
  - Exit codes are `0` pass, `1` policy threshold failed, `2` harness/run error,
    `3` kill-switch halt, `130` operator interrupt.
  - stdout remains JSON-only; diagnostics go to stderr.
  - A malformed workflow and corrupt state each produce a typed payload with a
    stable error code.
  - Tests assert exit codes and stdout/stderr separation.
- **Verification:** `pnpm --filter @lemma/core test -- errors` — **PASS** (4 tests; core suite 32/32 passed). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/errors.ts` (typed error catalog: `HarnessError`, `WorkflowError`/`MalformedWorkflowError`, `StateError`/`CorruptStateError`, `PersonaError`, `PluginError`, `PolicyError`/`PolicyThresholdError`, `AuthError`, `QuotaError`, `BillingError`, `QueueError`, `SsrfError`, `RedactionError`, `KillSwitchHaltError`, `OperatorInterruptError`; stable `ErrorCode`/payloads; `EXIT_CODES` 0/1/2/3/130; `exitCodeForError`/`toErrorPayload`), `packages/cli/src/errors.ts` (`writeJsonStdout`, `writeDiagnosticStderr`, `emitError`, `runCli` enforcing JSON-only stdout + stderr diagnostics), `packages/core/test/errors/errors.test.ts` (error catalog, exit-code mapping table assertions, malformed-workflow/corrupt-state stable payloads, stdout/stderr separation). Commit/remote recorded in completion summary.

### LEM-008 — Port the redaction engine and synthetic corpus

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-004
- **Status:** Done
- **Claimed:** 2026-11-14 — acceptance test: `pnpm test --filter @lemma/core -- redaction`.
- **Description:** Port assay's redaction rules and extend the corpus for host
  and Jira surfaces: auth headers, cookies, bearer/basic tokens, private keys,
  provider keys, env assignments, storage-state cookies, and form answers.
- **Acceptance Criteria:**
  - At least 25 synthetic credential shapes are covered, plus Jira and storage
    state cases.
  - Redaction runs before state, evidence, log, stdout, and report persistence.
  - A deliberately broken redactor fails the corpus test.
  - Failure messages never print the original value.
  - Redaction is idempotent and does not corrupt non-secret content.
- **Verification:** `pnpm --filter @lemma/core test -- redaction` — **PASS** (5 tests; core suite 37/37 passed). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/redaction.ts` (`sanitizeUrl`, `redactText`, `redactSecretValue`, `redactUnknown`, `containsRedactionMarker`; key/header/token/credential/connection-string/JWT/storage-state/Jira patterns, deep payload redaction), `packages/core/test/redaction/fixtures/redaction-corpus.json` (30 synthetic shapes incl. Jira + storage state), `packages/core/test/redaction/redaction.test.ts` (corpus coverage, broken-redactor leak detection without printing originals, idempotence/non-secret preservation, URL/payload redaction, pre-persistence artifact scan), tracked artifact scan output `docs/parity/evidence/LEM-008-artifact-scan-output.json` (`leaked_count: 0`). Commit/remote recorded in completion summary.

### LEM-009 — Decide package naming, release flow, and consumer contracts

- **Epic:** E1 Platform Foundation
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-001, LEM-003
- **Status:** Done
- **Claimed:** 2026-11-14 — acceptance test: `pnpm publish --dry-run --recursive`.
- **Description:** Choose the npm scope and CLI name, define semver policy,
  Changesets release flow, provenance, peer-dependency policy, and the install
  contract for each host.
- **Acceptance Criteria:**
  - An ADR records the package scope (`@lemma/*` vs another scope) and CLI binary
    name.
  - `package.json` exports map is defined for every public entry point, with
    optional subpaths for browser and cloud.
  - Release flow uses Changesets, npm provenance, and a dry-run publish job.
  - Peer-dependency policy prevents Playwright and host SDKs from becoming
    required installs.
  - `SECURITY.md` and a vulnerability disclosure path exist.
- **Verification:** `pnpm publish --dry-run --recursive --no-git-checks` — **PASS** (dry-run exercised all 11 `@lemma/*` workspace packages; each reported `Skip publishing ... (dry run)` with exit 0). `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` passed (2026-11-14).
- **Evidence:** ADR `docs/adr/0002-package-scope-release-and-consumer-contracts.md` (scope `@lemma/*`, CLI binary `lemma`, semver/Changesets/provenance/dry-run/release flow, exports/optionality policy), package manifests updated across `packages/*` and `packages/adapters/*` (public publish metadata, explicit exports maps, `@lemma/core` optional subpaths `./browser` and `./cloud`, `@lemma/cli` `bin.lemma`, Playwright as optional peer on browser surface only, no host SDK required in core), `.changeset/config.json` + `.changeset/README.md` (Changesets flow), `.github/workflows/release-dry-run.yml` (CI dry-run publish job with npm provenance/OIDC permissions), `SECURITY.md` (private vulnerability reporting/disclosure path). Commit/remote recorded in completion summary.

### LEM-010 — Port atomic state, JSON, and file-lock primitives

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-001, LEM-007
- **Status:** Done
- **Claimed:** 2026-11-14 — acceptance test: `pnpm test --filter @lemma/core -- state`.
- **Description:** Build the shared primitives every stateful module uses:
  atomic JSON write (temp file + fsync + rename), typed JSON read, advisory file
  lock, directory creation, and kill-file write/read.
- **Acceptance Criteria:**
  - Atomic write never exposes a partial file, including on simulated crash
    between write and rename.
  - Corrupt JSON raises a typed error and preserves the last good file.
  - The lock is exclusive across processes and released on crash.
  - Behavior is verified on macOS, Linux, and Windows (CI or platform-specific
    job).
  - A kill file written from another process is observed between checks.
  - No package reimplements these primitives.
- **Verification:** `pnpm --filter @lemma/core test -- state` — **PASS** (5 tests; core suite 42/42 passed). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/state.ts` (`atomicWriteFile`/`atomicWriteJson` temp+fsync+rename with crash-injection hook support, `readJsonFile` typed reads raising `CorruptStateError`/`StateError` while preserving on-disk content, `acquireFileLock`/`withFileLock` advisory cross-process lock with stale/crash recovery, `ensureDir`, `writeKillFile`/`readKillFile`/`clearKillFile`/`killFileExistsSync`), exported from `@lemma/core`; `packages/core/test/state/state.test.ts` (simulated crash between write and rename, corrupt JSON typed error, cross-process exclusivity and crash recovery, cross-process kill-file observation between checks). Crash-injection/CI evidence: `docs/parity/evidence/LEM-010-state-test-output.txt`; cross-platform CI matrix added in `.github/workflows/ci.yml` (`state-primitives` on `ubuntu-latest`, `macos-latest`, `windows-latest`). Commit/remote recorded in completion summary.

### LEM-011 — Port progress state, events, history, retention, and kill file

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-010
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card) and acceptance test: `pnpm --filter @lemma/core test -- state`.
- **Description:** Port the durable run-state store above the shared primitives:
  progress (`progress.json`) persistence, append-only run events, run history
  indexing/recording, retention/prune operations, and kill-file request/observe
  semantics under the `.lemma/` state root.
- **Acceptance Criteria:**
  - `StateStore` (or equivalent store) manages `.lemma/` paths for progress,
    events, history, kill file, and evidence root, using shared atomic JSON/file
    primitives (no package-local reimplementation).
  - Progress state can be saved and loaded atomically (`progress.json`); missing
    state raises a typed `StateError`, corrupt/invalid state raises typed
    `StateError`/`CorruptStateError` without clobbering the stored file.
  - `appendEvent` appends JSONL records durably (one event per line) with a
    timestamp when absent; event logging failures do not crash state operations.
  - History is persisted as a versioned document, records run summaries (run id,
    status/decision/score/timestamps as available), sorts runs deterministically,
    and `recordRun` upserts by run id.
  - Retention/prune supports `keepRuns`, `olderThanDays`, and `dryRun`; protects
    required runs (latest, latest completed, halted as applicable), removes only
    allowed run history/evidence references safely, and never deletes outside the
    store evidence root.
  - Kill-file store semantics support request (reason/timestamp), read/observe
    reason, and clear; a kill requested from another process is observable.
  - Tests cover save/load progress, corrupt/missing state errors, JSONL event
    append, history record/sort/upsert, prune dry-run and retention behavior,
    and cross-process kill request observation.
- **Verification:** `pnpm --filter @lemma/core test -- state` — **PASS** (10 state tests incl. store; core suite 47/47 passed). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/state-store.ts` (`StateStore` over `.lemma/` for progress/events/history/kill/evidence root using shared atomic primitives; `saveProgress`/`loadProgress`/`clearProgress`, `appendEvent` JSONL with timestamp and non-fatal logging, versioned history load/save/`recordRun` upsert+deterministic sort, `prune` with `keepRuns`/`olderThanDays`/`dryRun` + protected runs and safe evidence removal, `requestKill`/`killRequest`/`clearKill`), exported from `@lemma/core`; `packages/core/test/state/state-store.test.ts` (progress save/load + missing/corrupt typed errors, JSONL append, history record/sort/upsert, prune dry-run/retention/safe deletion, cross-process kill request observation). Test output: `docs/parity/evidence/LEM-011-state-store-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-012 — Port the versioned workflow loader and phase invariant

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-004, LEM-007
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- workflows`.
- **Description:** Port assay's versioned workflow definitions and loader with
  the fixed five-phase invariant, using a small dependency-free YAML subset and
  typed workflow validation/errors.
- **Acceptance Criteria:**
  - Built-in `release-confidence` workflow defines the canonical five phases in
    fixed order: `risk_analysis`, `test_planning`, `execution`,
    `evidence_collection`, `confidence_scoring` (with stable titles/descriptions
    or equivalent deterministic metadata).
  - A dependency-free YAML subset loader parses workflow files (nested mappings,
    lists/mappings, scalars, comments, quoted strings, ints/floats/bools/null)
    and rejects unsupported YAML features, tabs/indentation errors, duplicates,
    and malformed structures with typed `WorkflowError`/`MalformedWorkflowError`.
  - Workflow validation enforces: object root, allowed top-level keys
    (`schema_version`, `id`, `name`, `version`, `description`, `phases`),
    non-empty `id`/`name`, valid `version`, allowed phase keys (`name`, `title`,
    `description`), exactly 5 phases, known phase names only, and **exact phase
    order matching the invariant**.
  - `loadWorkflowFile` reads/validates a file and raises typed workflow errors
    on IO/parse/validation failures; `loadWorkflows(dir)` loads `*.yaml`/`*.yml`
    from `.lemma/workflows` (or provided directory), returns empty for missing
    directory, and fails on malformed present files; duplicate workflow ids are
    rejected.
  - Public APIs/types are exported from `@lemma/core` and use shared typed errors
    (no package-local error classes).
  - Tests cover built-in workflow/invariant, valid file/directory loading,
    missing directory behavior, malformed/unsupported YAML cases, and phase/order
    validation failures.
- **Verification:** `pnpm --filter @lemma/core test -- workflows` — **PASS** (5 tests; core suite 52/52 passed). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/workflows.ts` (dependency-free YAML subset parser, typed validation/errors, `PHASE_ORDER` invariant, built-in `RELEASE_CONFIDENCE`, `loadWorkflowFile`, `loadWorkflows` with missing-dir-empty/duplicate-id rejection), exported from `@lemma/core`; `packages/core/test/workflows/workflows.test.ts` (built-in invariant, valid file/dir loading, missing dir, malformed/unsupported YAML, validation/order/duplicate/non-dir cases). Test output: `docs/parity/evidence/LEM-012-workflows-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-013 — Port domain models, findings, and normalization

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-004
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- models`.
- **Description:** Port assay's core domain enums/records and finding/outcome
  normalization primitives (model defaults, coercion, serialization/round-trips,
  and outcome drafts) as runtime utilities compatible with lemma contracts.
- **Acceptance Criteria:**
  - Domain enums/constants are implemented with assay-compatible values:
    `RunStatus`, `PhaseStatus`, `CheckStatus`, `Severity`, `Strength`,
    `SCHEMA_VERSION`/`MODEL_SCHEMA_VERSION`, and severity ranking helpers.
  - Plain-object domain normalization/serde helpers exist for core records:
    `Target`, `Risk`, `Finding`, `InvalidFinding`, `Blocker`, `Check`, `Phase`,
    `Confidence`, `KillSwitch`, and `RunState` (create/from/normalize/to-object
    or equivalent), applying defaults/coercion and preserving stable shapes for
    JSON round-trips.
  - Finding/outcome primitives exist: `FindingDraft`, `BlockerDraft`,
    `CheckOutcome` with `addFinding`/`addBlocker` behavior and `clampSeverity`
    (invalid/empty severity normalizes safely) consistent with assay semantics.
  - Model timestamp/id defaults integrate with deterministic providers (current
    clock/entropy helpers) without requiring callers to pass explicit values.
  - Public APIs are exported from `@lemma/core` without breaking existing schema
    exports; tests cover enum values, normalization/defaulting/coercion,
    round-trips, and outcome draft behavior.
- **Verification:** `pnpm --filter @lemma/core test -- models` — **PASS** (4 tests; core suite 56/56 passed). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/models.ts` (assay-compatible domain enums/constants and severity ranking/clamp, normalization/serde helpers for Target/Risk/Finding/InvalidFinding/Blocker/Check/Phase/Confidence/KillSwitch/RunState, deterministic timestamp/id defaults via `now`/`newId`, outcome drafts `FindingDraft`/`BlockerDraft` and `CheckOutcome` with `addFinding`/`addBlocker`), exported from `@lemma/core`; `packages/core/test/models/models.test.ts` (enum values, coercion/defaulting, JSON round-trips, deterministic defaults, outcome behavior/clamp). Test output: `docs/parity/evidence/LEM-013-models-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-014 — Port the check catalog, registry, and intent planning

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-013
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- checks`.
- **Description:** Port assay's stable check catalog/definitions and intent-linked
  planning primitives (applicability, selection/registry hooks, and risk weight
  application) as core utilities compatible with lemma domain models.
- **Acceptance Criteria:**
  - `CHECK_CATALOG` contains the 24 assay checks with stable ids and matching
    metadata (title, domain, kind, intent, expected, `base_weight`, `requires`,
    legacy `persona` empty for built-ins) and `catalogIds` returns catalog/registry ids.
  - Intent/category helpers and applicability implement assay semantics for
    category markers (`static.full_assessment`, `test/functionality/browser/issues/demo/more`),
    `browser.steps` scenario gating, source/markup/manifest/url requirements, and
    mobile-only checks (`browser.overflow`, `browser.focus_order`).
  - `planChecks` builds planned `Check` records from definitions + target/inventory +
    ownership/selection inputs, setting owner/persona, initial weight/status, and
    completed/blocked metadata for blocked plugin checks; it filters by selected
    owners and applicability, respects `max_checks`, and raises typed
    `HarnessError` for non-plugin ownership violations, missing applicable checks,
    or `max_checks` removing all checks.
  - Registry-compatible hooks/interfaces support definition/ids/source, blocked
    reasons, owner hints, and blocking (for plugin planning paths) without
    depending on `@lemma/core` plugin implementation.
  - `applyRiskWeights` applies per-domain max risk multipliers to planned checks
    (rounded as assay does) and APIs are exported from `@lemma/core` with tests
    covering catalog, applicability/intent planning, ownership/registry behavior,
    error cases, and risk weighting.
- **Verification:** `pnpm --filter @lemma/core test -- checks` — **PASS** (4 tests; core suite 60/60 passed). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/checks.ts` (24-check `CHECK_CATALOG` with assay-compatible metadata, `catalogIds`, intent/category helpers, applicability incl. category markers/browser-availability rules/scenario/mobile filters, `planChecks` with ownership/selection/registry hooks, blocked-plugin handling, deterministic blocked timestamps, typed errors, and `applyRiskWeights` using per-domain max multipliers with assay-style rounding), exported from `@lemma/core`; `packages/core/test/checks/checks.test.ts` (catalog, intent/applicability, planning/selection/ownership/registry/errors, risk weighting). Test output: `docs/parity/evidence/LEM-014-checks-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-141 — Build the conversational test manager persona

- **Epic:** E13 Conversational Agent Surface
- **Priority:** P1
- **Points:** 8
- **Depends on:** LEM-086, LEM-091, LEM-094
- **Status:** Backlog
- **Claimed:** —
- **Description:** Build a "manager" persona that leads the testing session
  conversationally — plans the run, asks clarifying questions, narrates
  progress, and explains findings. This persona is the user-facing lead QA
  voice; specialist personas remain check owners, but the manager persona owns
  the interaction with the operator. Mirrors CARBON's "Jay" lead.
- **Acceptance Criteria:**
  - `packages/personas/manager.md` exists as a valid persona frontmatter
    contract, parses via `parsePersonaFrontmatter`, passes `lintPersonas`, and
    owns no checks (ownership fields empty or reserved) so the disjointness
    invariant (LEM-044) is unchanged.
  - Manager persona defines conversational responsibilities: session planning,
    question flow (via LEM-091 context protocol), progress narration (via
    LEM-094), and final explanation, with a stable output schema for `plan`,
    `question`, `progress`, and `summary` message types (committed under
    `schemas/agent/manager-message.v1.json`).
  - `packages/agent` exposes a manager-orchestration entrypoint (e.g.
    `ManagerSession`) that wires the manager persona into the bounded agent
    loop (LEM-086) and routes plan/question/progress/summary events to a
    host-neutral message sink.
  - Manager responses are redacted via `@lemma/core/redaction` before being
    persisted or emitted to the host; failure messages never print original
    secret values.
  - Manager session state persists under `.lemma/agent/manager.json` via
    `@lemma/core/state` and is resumable (LEM-087) with byte-identical replay
    given the same seed/clock.
  - Manager output is deterministic: same seed + frozen clock + same assessment
    produce byte-identical narration text (only documented volatile fields like
    `generated_at` differ).
  - Tests cover persona parsing/lint, message routing, redaction, determinism,
    and resumability.
- **Verification (planned):** `pnpm --filter @lemma/agent test -- manager`
- **Evidence (planned):** `packages/personas/manager.md`,
  `packages/agent/src/manager-session.ts`,
  `schemas/agent/manager-message.v1.json`, `packages/agent/test/manager/*`,
  `docs/parity/evidence/LEM-141-manager-test-output.txt`

### LEM-142 — Build portable self-contained HTML report export

- **Epic:** E14 Visual Evidence and Reporting Surface
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-020
- **Status:** Backlog
- **Claimed:** —
- **Description:** Build a self-contained HTML report (single file, inline
  CSS/JS, embedded evidence thumbnails or documented escaped relative links)
  that renders findings, evidence references, scores, decisions, blockers, and
  contract health — viewable in any modern browser without the lemma runtime or
  a running server.
- **Acceptance Criteria:**
  - `@lemma/core` exports `buildHtmlReport(report, evidenceStore?)` returning a
    single HTML string that validates as UTF-8 and is under a documented size
    ceiling for typical runs.
  - Report renders: findings (severity, id, check, evidence links), blockers,
    invalid findings, contract health, confidence/decision, coverage, policy
    result, trend diff (if present), and evidence summary — with the same data
    as the JSON report.
  - Evidence references are resolved from `EvidenceStore` to safe inline data
    URIs (or documented escaped relative hrefs when too large); no absolute
    paths leak; no secrets leak (redaction applied before embedding).
  - HTML is deterministic given the same report + evidence; only documented
    volatile fields vary.
  - The HTML report is written via `@lemma/core/state` atomic write to a
    user-specified path (or `<root>/lemma-report.html`); no accidental writes
    elsewhere.
  - Tests cover rendering of every section, deterministic output, redaction,
    evidence embedding/escaping, size ceiling behavior, and refusal to include
    absolute paths.
- **Verification (planned):** `pnpm --filter @lemma/core test -- html-report`
- **Evidence (planned):** `packages/core/src/html-report.ts`,
  `packages/core/test/html-report/*`,
  `packages/core/test/html-report/fixtures/sample-report.html`,
  `docs/parity/evidence/LEM-142-html-report-test-output.txt`

### LEM-143 — Build the local visual evidence dashboard (shell + live investigation view)

- **Epic:** E14 Visual Evidence and Reporting Surface
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-016, LEM-020, LEM-061
- **Status:** Backlog
- **Claimed:** —
- **Description:** Build a host-neutral, localhost-only dashboard that serves a
  live investigation view of the current run: current phase, current check,
  in-flight evidence, and a rolling feed of completed checks with links into
  evidence. Serves only on `127.0.0.1` with a per-run token issued at start; no
  remote serving, no auth bypass.
- **Acceptance Criteria:**
  - `@lemma/core/dashboard` (or `@lemma/core` subpath) exports
    `startDashboard({ stateStore, evidenceStore, report, host: '127.0.0.1', port?: number })`
    returning a handle `{ url, token, close() }`.
  - Server binds only to `127.0.0.1`; attempts to bind to `0.0.0.0` fail with a
    typed `HarnessError`. Every route (including `/healthz`) requires the token
    in a header or query param and rejects missing/mismatched tokens with
    `401` and a JSON body only.
  - Serves a live investigation view: current phase, current check
    id/title/owner, in-flight evidence refs, rolling completed check feed, and
    (when present) the report summary. No write endpoints in this task
    (settings handled by LEM-146).
  - Reads state exclusively through `StateStore`/`EvidenceStore`; no direct
    filesystem reads outside those; no writes.
  - Dashboard is disabled when `LEMMA_DASHBOARD=off` or `--no-dashboard` is
    passed; explicitly documented in evidence.
  - Tests: bind-only-127.0.0.1, token required on every route, missing/mismatched
    token → 401 JSON, live view reflects current progress, safe no-op on missing
    state.
- **Verification (planned):** `pnpm --filter @lemma/core test -- dashboard`
- **Evidence (planned):** `packages/core/src/dashboard.ts`,
  `packages/core/test/dashboard/dashboard.test.ts`,
  `docs/adr/0003-local-dashboard-serving-and-token-auth.md`,
  `docs/parity/evidence/LEM-143-dashboard-test-output.txt`

### LEM-144 — Capture and display screenshots for browser check evidence

- **Epic:** E14 Visual Evidence and Reporting Surface
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-051, LEM-143
- **Status:** Backlog
- **Claimed:** —
- **Description:** Ensure every browser check that can capture a screenshot does
  so, saves it to the evidence store under the check's evidence directory, and
  surfaces the screenshot in the dashboard and HTML report linked to the exact
  check and finding.
- **Acceptance Criteria:**
  - `packages/browser` captures a full-page screenshot per browser check
    execution (subject to runtime capability) and persists it to
    `.lemma/evidence/<run_id>/<check_id>/screenshot-<n>.png` through the
    `EvidenceStore` API; the returned ref attaches to `CheckOutcome.evidence`
    and, where applicable, to findings.
  - Browser-unavailable or blocked runs never fabricate a screenshot — outcome
    remains `blocked` (per LEM-050) with no screenshot evidence and an explicit
    blocker.
  - Dashboard (LEM-143) renders the screenshot thumbnail in the check row and,
    on click, the full-size screenshot in a panel. Missing evidence files render
    a clear "evidence unavailable" placeholder, not a broken image.
  - HTML report (LEM-142) embeds or links screenshots per the same contract;
    LEM-061 evidence-linkage guarantees hold (every screenshot ref resolves to
    an existing file).
  - Redaction: any screenshot containing known secret values (per
    `@lemma/core/redaction` corpus) is not captured, or the run is marked so the
    dashboard/report shows a redaction note; policy documented in evidence.
  - Tests cover capture path, blocked-run behavior, dashboard rendering refs,
    HTML report refs, and missing-evidence fallback.
- **Verification (planned):**
  `pnpm --filter @lemma/browser test -- screenshot && pnpm --filter @lemma/core test -- screenshot-linkage`
- **Evidence (planned):** `packages/browser/src/checks.ts` (screenshot capture),
  `packages/core/src/dashboard.ts` (rendering),
  `packages/core/src/html-report.ts` (embedding),
  `docs/parity/evidence/LEM-144-screenshot-evidence-test-output.txt`

### LEM-145 — Add Release Brief stakeholder summary

- **Epic:** E14 Visual Evidence and Reporting Surface
- **Priority:** P2
- **Points:** 3
- **Depends on:** LEM-020, LEM-143
- **Status:** Backlog
- **Claimed:** —
- **Description:** Generate a concise stakeholder-facing Release Brief from a
  completed report: decision, confidence, top findings, blocked coverage, and
  explicit next steps. Served as a dashboard panel and exportable as a portable
  artifact (Markdown and/or self-contained HTML), deterministic given the same
  report.
- **Acceptance Criteria:**
  - `@lemma/core` exports `buildReleaseBrief(report)` returning a structured
    object plus rendered Markdown/HTML; both validate against committed schema
    `lemma.release_brief/v1`.
  - Release Brief surfaces `decision`, `confidence`, `coverage`,
    `ship/review/hold` context, top-N findings (N configurable, default 5) with
    check and severity, all blockers/refusals as explicit coverage gaps, and
    next-step lines derived deterministically (no LLM-only wording).
  - Served as a dedicated dashboard route (`/brief`) with the same token policy
    as LEM-143, and exportable via a documented `@lemma/core` helper
    (`lemma report --brief` CLI wiring follows once LEM-085 surface is present).
  - Redaction applied before brief generation and before persistence.
  - Tests cover schema validation, deterministic output, top-N behavior, blocker
    inclusion, dashboard rendering, and redaction.
- **Verification (planned):** `pnpm --filter @lemma/core test -- release-brief`
- **Evidence (planned):** `packages/core/src/release-brief.ts`,
  `schemas/release_brief/release_brief.v1.schema.json`,
  `packages/core/test/release-brief/*`,
  `docs/parity/evidence/LEM-145-release-brief-test-output.txt`

### LEM-146 — Add interactive settings UI to the dashboard

- **Epic:** E14 Visual Evidence and Reporting Surface
- **Priority:** P2
- **Points:** 3
- **Depends on:** LEM-143
- **Status:** Backlog
- **Claimed:** —
- **Description:** Add a protected settings page to the dashboard to view and
  adjust budget (`maxChecks`, time budget), project focus (folder/URL), and
  analytics preference. Writes go through the same state primitives and the same
  typed settings contract as `lemma settings` (CLI), keeping a single source of
  truth.
- **Acceptance Criteria:**
  - `@lemma/core` defines a versioned settings schema (`lemma.settings/v1`) with
    at minimum: `budget.minutes`, `budget.maxChecks`, `focus.project`,
    `focus.url`, `analytics.enabled`, and `analytics.endpoint` (or documented
    equivalent).
  - Dashboard route `GET/POST /settings` is protected by the same token as
    LEM-143; every write is validated against the schema and rejected with a
    `400` typed JSON error on invalid input.
  - Reads/writes go through `@lemma/core/state` primitives (atomic write, typed
    read) to `.lemma/settings.json`; no ad-hoc file writes; corrupt reads raise
    typed `StateError`.
  - Every settings change is appended as a JSONL audit event via `StateStore`
    (LEM-011) with previous and new values (secrets redacted). The dashboard
    settings UI never bypasses redaction or audit.
  - CLI `lemma settings` and the dashboard share the same schema and state file;
    tests assert round-trip consistency.
  - Tests: schema validation, dashboard POST/invalid → 400 typed JSON, atomic
    write, audit event emission, CLI/dashboard parity of the state file.
- **Verification (planned):** `pnpm --filter @lemma/core test -- settings`
- **Evidence (planned):** `packages/core/src/settings.ts`,
  `packages/core/src/dashboard.ts` (settings route),
  `schemas/settings/settings.v1.schema.json`, `packages/core/test/settings/*`,
  `docs/parity/evidence/LEM-146-settings-test-output.txt`

### LEM-147 — Build journey map visualization

- **Epic:** E14 Visual Evidence and Reporting Surface
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-058, LEM-143
- **Status:** Backlog
- **Claimed:** —
- **Description:** Visualize, in the dashboard, the paths the AI took during
  testing: routes visited, checks applied per route, outcomes per check, and the
  resulting evidence. This is CARBON's "Journey Atlas" equivalent, expressed
  from the deterministic run record (no inference).
- **Acceptance Criteria:**
  - `@lemma/core` exports `buildJourneyMap(report, { scenarioPlan?, browserEvidence? })`
    returning a structured graph (nodes = routes/views; edges = observed
    navigation/transitions; labels = checks run) validated against
    `lemma.journey_map/v1`.
  - Dashboard (LEM-143) renders the map as an accessible graph (SVG or canvas)
    with a textual fallback: a table of routes → checks → outcomes. Route is
    token-protected like the rest of the dashboard.
  - The journey map is derived only from run artifacts (scenario plans per
    LEM-058 and browser evidence refs); no LLM inference or invented
    transitions. Determinism: same seed + same run → same graph structure and
    ordering.
  - Screenshots (LEM-144) link from each graph node/edge where evidence exists;
    missing evidence shows the same "unavailable" placeholder as LEM-144.
  - Tests cover graph construction determinism, schema validation, dashboard
    rendering (including textual fallback), and consistency with evidence refs.
- **Verification (planned):**
  `pnpm --filter @lemma/core test -- journey-map && pnpm --filter @lemma/browser test -- journey-map-links`
- **Evidence (planned):** `packages/core/src/journey-map.ts`,
  `packages/core/src/dashboard.ts` (journey map route),
  `schemas/journey_map/journey_map.v1.schema.json`,
  `packages/core/test/journey-map/*`,
  `docs/parity/evidence/LEM-147-journey-map-test-output.txt`

### LEM-148 — Build the dedicated bug-hunting workflow

- **Epic:** E13 Conversational Agent Surface
- **Priority:** P1
- **Points:** 8
- **Depends on:** LEM-044, LEM-058, LEM-089
- **Status:** Backlog
- **Claimed:** —
- **Description:** Add a first-class bug-hunting workflow (`lemma hunt` /
  `lemma issues` catalog entry) that drives multi-step user journeys, simulates
  specialist personas per step, and records sequence-dependent defects with
  evidence — distinct from the standard five-phase assessment and from generic
  browser checks.
- **Acceptance Criteria:**
  - `@lemma/core` exposes
    `runBugHunt({ target, scenarioPlan?, personas, maxSteps, seed, clock }, { browserRuntime?, pluginRunner? })`
    that orchestrates bounded, stateful exploration of a user journey, produces
    `Finding`/`Blocker` drafts, and returns a `BugHuntResult` with a
    documented shape in `@lemma/core` types.
  - Bounded by `maxSteps` (default ≤ 20, configurable) and a wall-clock budget;
    exceeding either stops cleanly with a `halted` status, not a crash, and
    yields typed errors consistent with LEM-007.
  - Personas invoked during hunting are the existing specialist contracts
    (LEM-043); ownership rules (LEM-044) still hold — a check owned by one
    persona cannot be evaluated by another, and invalid findings are quarantined
    per LEM-045.
  - Every emitted finding carries evidence refs from the run evidence directory;
    runs with browser unavailable produce `blocked` coverage gaps per LEM-050
    (never a pass), and blocked steps are recorded as explicit coverage
    limitations.
  - Exposed as a catalog command (`lemma hunt`) mapped through LEM-089 intent
    mapping; agent loop (LEM-086) can drive it; the command's presence and
    behavior asserted in command-catalog parity (LEM-095) once it lands.
  - Determinism: same seed + frozen clock + same target/scenario → same
    findings/ids/evidence fingerprints (modulo documented volatile fields).
  - Tests cover bounded stop on `maxSteps`/time, blocked-run behavior,
    persona/ownership invariants, evidence linkage, determinism, and
    command-catalog wiring.
- **Verification (planned):**
  `pnpm --filter @lemma/core test -- bug-hunt && pnpm --filter @lemma/agent test -- bug-hunt`
- **Evidence (planned):** `packages/core/src/bug-hunt.ts`,
  `packages/core/src/commands.ts` (catalog entry),
  `packages/core/test/bug-hunt/*`, `packages/agent/test/bug-hunt/*`,
  `docs/parity/evidence/LEM-148-bug-hunt-test-output.txt`

### LEM-149 — Extend dynamic accessibility testing (keyboard traversal, live contrast, screen-reader hints)

- **Epic:** E14 Visual Evidence and Reporting Surface
- **Priority:** P2
- **Points:** 5
- **Depends on:** LEM-053, LEM-055
- **Status:** Backlog
- **Claimed:** —
- **Description:** Extend the browser accessibility check beyond structural
  markup: verify keyboard traversal order for interactive elements, evaluate
  live contrast ratios against WCAG AA thresholds in the rendered DOM, and
  produce screen-reader compatibility hints (ARIA role/name/state sanity). All
  results are evidence-backed; blocked-runtime runs remain `blocked`.
- **Acceptance Criteria:**
  - Keyboard traversal: `browser.accessibility` includes a bounded tab-traversal
    evaluation (max N focusable elements, default 50) that records the observed
    focus order, flags unreachable or trap-prone regions, and cites the DOM
    sequence as structured metadata and a screenshot evidence ref (via LEM-144).
  - Live contrast: samples foreground/background color pairs of visible text
    nodes and reports violations against WCAG AA thresholds (normal and large
    text); findings include the computed ratio, WCAG level (AA/AAA), and
    evidence refs (screenshot + structured JSON via `context.saveJson`-style
    evidence).
  - Screen-reader hints: reports missing or contradictory accessible names
    (role/name/state), duplicate landmarks, and interactive elements without an
    accessible name; the check does not fabricate screen-reader output — it
    reports contract violations and a `manual_review_required` list, consistent
    with LEM-053.
  - Blocked-runtime behavior: with Playwright unavailable, extended checks
    degrade to `blocked` (per LEM-050) with explicit coverage notes; never a
    pass.
  - Determinism: same target and viewport produce the same set of findings
    (modulo documented volatile fields); evidence artifact names are stable.
  - Tests cover keyboard traversal scenarios (happy path, trap, unreachable),
    contrast scenarios (pass, fail-AA, fail-large-text), screen-reader hint
    coverage, blocked-runtime behavior, and determinism.
- **Verification (planned):**
  `pnpm --filter @lemma/browser test -- accessibility-dynamic`
- **Evidence (planned):** `packages/browser/src/checks.ts` (extended a11y
  evaluators), `packages/browser/test/accessibility-dynamic/*`,
  `docs/parity/evidence/LEM-149-dynamic-a11y-test-output.txt`

### LEM-150 — Build the background quick-check supervisor

- **Epic:** E13 Conversational Agent Surface
- **Priority:** P2
- **Points:** 5
- **Depends on:** LEM-084, LEM-086
- **Status:** Backlog
- **Claimed:** —
- **Description:** Add an optional background supervisor that runs bounded,
  lightweight quick checks while the developer works, with pause/review/disable
  controls. Disabled by default; global off switch (`LEMMA_BACKGROUND=off`);
  every background run writes only to `.lemma/background/` so foreground state
  is never perturbed.
- **Acceptance Criteria:**
  - `@lemma/core` exports
    `startBackgroundSupervisor({ stateStore, settings, maxConcurrent?, budget })`
    returning `{ pause(), resume(), status(), stop() }`; supervisor is a no-op
    and exits cleanly when `settings.background.enabled === false` (default) or
    env `LEMMA_BACKGROUND=off`.
  - Supervisor schedules at most `maxConcurrent` (default 1) lightweight checks
    (documented allowlist — static checks and non-browser quick checks only;
    browser checks excluded by default with explicit opt-in) at a bounded
    interval; every check is bounded by a wall-clock budget and cannot starve
    the foreground.
  - All background state, evidence, and logs write only under
    `.lemma/background/`; supervisor never writes into `.lemma/state/`,
    `.lemma/events.jsonl`, `.lemma/history.json`, or the foreground run's
    evidence directory — verified by a test that runs a foreground assessment
    concurrently and asserts byte-identical foreground artifacts.
  - Pause/resume/status/stop are reflected in a JSONL event stream under
    `.lemma/background/events.jsonl` (via `StateStore` event path scoped to
    background) and queryable from the CLI.
  - Background checks are bounded, deterministic-when-seeded, and never produce
    findings that leak into the foreground report. Background findings appear
    only in a background-specific summary that the CLI surfaces under
    `lemma status --background` (documented).
  - Kill file (LEM-011) is honored: a global kill stops background work within
    one interval; a background-specific kill file stops only background work.
  - Tests: default-off behavior, env-off behavior, concurrency limit,
    foreground-isolation byte-identical check, event stream, kill file
    semantics, and a bounded-time test asserting no starvation.
- **Verification (planned):**
  `pnpm --filter @lemma/core test -- background-supervisor && pnpm --filter @lemma/cli test -- background`
- **Evidence (planned):** `packages/core/src/background-supervisor.ts`,
  `packages/cli/src/background.ts`,
  `packages/core/test/background-supervisor/*`,
  `packages/cli/test/background/*`,
  `docs/parity/evidence/LEM-150-background-supervisor-test-output.txt`

### LEM-151 — Build the native MCP server exposing testing tools

- **Epic:** E15 MCP Tool Server
- **Priority:** P1
- **Points:** 8
- **Depends on:** LEM-083, LEM-086, LEM-098
- **Status:** Backlog
- **Claimed:** —
- **Description:** Ship a first-class MCP (Model Context Protocol) server that
  exposes lemma's testing tools to any MCP-compatible coding agent. Distinct
  from adapter-level bridges; adapters may still use the SDK (LEM-098), but the
  MCP server is a standalone transport any MCP client can speak to.
- **Acceptance Criteria:**
  - A standalone MCP server entrypoint ships in `@lemma/core/mcp` (or a
    dedicated `@lemma/mcp` package if the architecture ADR is amended) exposing
    at minimum `lemma_start`, `lemma_update`, `lemma_report`, `lemma_settings`,
    `lemma_demo`, `lemma_knowledge`, with JSON-Schema-described inputs/outputs
    committed under `schemas/mcp/`.
  - Server speaks the current MCP transport (stdio and/or streamable HTTP) and
    conforms to the MCP spec version pinned in the ADR; conformance validated by
    a repo-owned MCP client fixture that exercises every tool.
  - Every tool call routes through `@lemma/core` public APIs only (no direct
    imports of adapter packages); errors are `HarnessError`-shaped and never
    leak stack traces; stdout is JSON-RPC only.
  - Tool calls are redaction-safe: arguments and results pass through
    `@lemma/core/redaction` before being logged; any tool that writes to disk
    uses `@lemma/core/state` atomic writes and never escapes `.lemma/`.
  - Deterministic when seeded: `lemma_start` accepts `seed` and `clock` and
    produces byte-identical run artifacts for repeated seeded calls (subject to
    the same volatile-field contract as the CLI).
  - Adapter packages that previously used an "MCP bridge" (Cursor adapter per
    README) migrate to the native server or document why not; a smoke test
    asserts the Cursor adapter can talk to the native server.
  - Tests: MCP client fixture per tool, JSON-RPC framing, redaction of
    args/results, no-import-of-adapters dependency-direction assertion,
    determinism, and adapter compatibility.
- **Verification (planned):**
  `pnpm --filter @lemma/core test -- mcp && pnpm --filter @lemma/adapters-cursor test -- mcp-smoke`
- **Evidence (planned):** `packages/core/src/mcp/*`,
  `packages/core/src/mcp/index.ts`, `schemas/mcp/**`,
  `packages/core/test/mcp/*`,
  `packages/adapters/cursor/test/mcp-smoke/*`,
  `docs/adr/0004-native-mcp-server-and-transport.md`,
  `docs/parity/evidence/LEM-151-mcp-test-output.txt`

### LEM-152 — Add optional anonymous usage analytics with opt-out

- **Epic:** E16 Commercial and UX Extras
- **Priority:** P2
- **Points:** 3
- **Depends on:** LEM-083
- **Status:** Backlog
- **Claimed:** —
- **Description:** Add optional, anonymous usage analytics with a clear opt-out
  and no code/prompt/personal data. Enabled-by-default behavior is a policy
  decision recorded in the ADR; the board does not assume it. Analytics must
  never block, slow, or fail a run.
- **Acceptance Criteria:**
  - An ADR (`docs/adr/0005-analytics-default-and-endpoint.md`) records whether
    analytics defaults on or off, the endpoint, the exact event payload schema,
    and the privacy review.
  - `@lemma/core` exports `analytics.recordEvent(name, props?)` that: (a) is a
    no-op when disabled via settings `analytics.enabled=false` or env
    `LEMMA_ANALYTICS=off`; (b) validates the event name against an allowlist and
    rejects unknown names with a typed error; (c) strips properties not on a
    documented allowlist (no prompts, no code, no paths outside repo root, no
    ids beyond a per-install random UUID stored in `.lemma/analytics-install-id`).
  - Events are buffered and flushed asynchronously with a hard timeout; a
    network failure never fails the run and never appears in stdout; diagnostics
    go to stderr.
  - Dashboard settings UI (LEM-146) exposes an `analytics.enabled` toggle wired
    to the same state; toggling is recorded as a JSONL audit event via
    `StateStore`.
  - Tests cover: default per ADR, disabled-by-env, disabled-by-settings,
    unknown-event rejection, allowlist stripping (assert no forbidden fields
    reach the transport), async timeout does not affect the run, audit event on
    toggle.
- **Verification (planned):** `pnpm --filter @lemma/core test -- analytics`
- **Evidence (planned):** `packages/core/src/analytics.ts`,
  `packages/core/test/analytics/*`,
  `docs/adr/0005-analytics-default-and-endpoint.md`,
  `docs/parity/evidence/LEM-152-analytics-test-output.txt`

### LEM-153 — Build the user-facing demo project generator (`lemma demo`)

- **Epic:** E13 Conversational Agent Surface
- **Priority:** P2
- **Points:** 3
- **Depends on:** LEM-038, LEM-083
- **Status:** Backlog
- **Claimed:** —
- **Description:** A user-facing `lemma demo` command that generates a
  disposable, intentionally flawed sample project so new users can try lemma
  end-to-end without using their own code. The generated project must be clearly
  marked test-only, safely scoped, and never deployable.
- **Acceptance Criteria:**
  - `lemma demo` (CLI, mapped via LEM-083/LEM-089) generates a demo project into
    a user-specified directory (default `./lemma-demo`), refusing to overwrite a
    non-empty directory unless `--force` is passed with a confirmation prompt or
    explicit `--yes`.
  - Generated project includes: a `README.md` with the "this is a test-only
    demo, do not deploy" warning at the top; a `.lemma-demo` marker file so
    tooling can detect it; a `NOT-FOR-DEPLOYMENT` file; and a small web app with
    documented intentional flaws (missing alt text, an exposed secret-shaped
    string that lemma's secret scan should flag, one broken link) that exercise
    the default catalog.
  - Command is idempotent given the same target and seed; on re-run into an
    existing demo-marker directory, it either refuses or regenerates
    deterministically (per a documented policy).
  - Running `lemma run` against the generated demo (with browser unavailable)
    produces a blocked-but-informative report that exercises static checks; with
    browser available, browser checks run and produce evidence. A test asserts
    the demo is usable end-to-end.
  - Demo generator never writes outside its target directory and never mutates
    existing user files.
  - Tests: generation, marker files, refusal on non-empty without `--force`,
    idempotence, end-to-end `lemma run` against the generated demo, and no
    writes outside target.
- **Verification (planned):**
  `pnpm --filter @lemma/cli test -- demo && pnpm --filter @lemma/core test -- demo-fixture`
- **Evidence (planned):** `packages/cli/src/demo.ts`,
  `packages/cli/test/demo/*`, `packages/core/test/demo-fixture/*`,
  `docs/parity/evidence/LEM-153-demo-test-output.txt`

### LEM-154 — Verify and complete the in-chat slash-command interface

- **Epic:** E13 Conversational Agent Surface
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-089, LEM-091, LEM-106
- **Status:** Backlog
- **Claimed:** —
- **Description:** Ensure the agent loop natively understands and responds to
  slash commands inside the AI chat (`/lemma`, `/lemma-test`, `/lemma-issues`,
  `/lemma-accessibility`, `/lemma-map`, `/lemma-help`, `/lemma-settings`,
  `/jay`, `/full`, `/lemma-background`, `/lemma-pro`), mapping each to a catalog
  entry (LEM-089), a manager-persona flow (LEM-141, LEM-091), and — where
  applicable — a dashboard route (LEM-143–LEM-147). Adapters (LEM-101/102) rely
  on this host-neutral contract.
- **Acceptance Criteria:**
  - `@lemma/agent` defines a host-neutral `SlashCommandRouter` that, given a raw
    chat message, recognizes slash commands from a documented, versioned
    command catalog (`schemas/agent/slash-commands.v1.json`) and returns a typed
    routing decision (command id, arguments, target: `manager` | `catalog` |
    `dashboard` | `unknown`).
  - Catalog includes at minimum `/lemma`, `/lemma-test`, `/lemma-issues`,
    `/lemma-accessibility`, `/lemma-map`, `/lemma-help`, `/lemma-settings`,
    `/jay`, `/full`, `/lemma-background`, `/lemma-pro`; each maps to a specific
    intent (LEM-089 entry, LEM-141 manager flow, and/or LEM-143+ dashboard
    route) with documented arguments and error cases.
  - Unknown slash commands produce a typed "unknown command" response with a
    helpful hint list from `lemma-help` — never silent failures, never
    fabricated execution.
  - Slash-command invocations flow through the manager persona (LEM-141) and its
    narration; commands that open the dashboard (e.g. `/lemma-map`) return the
    token-protected URL via the manager, never the token itself in the visible
    transcript (token surfaced only to the host's UI channel where supported).
  - Router is redaction-safe: argument echoing and error messages pass through
    `@lemma/core/redaction`.
  - Tests: router coverage of every documented command, argument parsing,
    unknown-command behavior, manager-flow integration, dashboard-route
    integration (mock), redaction, and agent-loop (LEM-086) honoring router
    decisions.
- **Verification (planned):**
  `pnpm --filter @lemma/agent test -- slash-commands && pnpm --filter @lemma/core test -- slash-command-catalog`
- **Evidence (planned):** `packages/agent/src/slash-commands.ts`,
  `schemas/agent/slash-commands.v1.json`,
  `packages/agent/test/slash-commands/*`,
  `docs/parity/evidence/LEM-154-slash-commands-test-output.txt`

### LEM-155 — Add Pro edition navigation and informational page

- **Epic:** E16 Commercial and UX Extras
- **Priority:** P3
- **Points:** 2
- **Depends on:** LEM-143
- **Status:** Backlog
- **Claimed:** —
- **Description:** A short in-product affordance that opens an informational
  page describing the Pro edition (feature list, pricing summary, learn-more
  link). No checkout, no telemetry, no account requirement. Purely a navigation
  page.
- **Acceptance Criteria:**
  - Dashboard (LEM-143) exposes a token-protected `/pro` route that renders a
    static, self-contained informational page (inline CSS, no external scripts)
    describing Pro edition features, a pricing summary, and a learn-more link;
    no external calls, no cookies beyond the auth token.
  - `/lemma-pro` slash command (mapped via LEM-154) routes to this dashboard page
    when the dashboard is running; when the dashboard is off, it returns a
    static text summary with the same learn-more link, so it is useful in
    CLI/agent-only contexts.
  - The page explicitly states it is informational and does not start a
    checkout, does not collect data, and does not require an account —
    consistent with the privacy-first posture.
  - Tests: `/pro` route requires token, renders expected section markers, has no
    external `<script>`/`<link>`/`<img>` tags, and `/lemma-pro` returns the
    right summary in both dashboard-on and dashboard-off modes.
- **Verification (planned):**
  `pnpm --filter @lemma/core test -- pro-page && pnpm --filter @lemma/agent test -- pro-command`
- **Evidence (planned):** `packages/core/src/dashboard.ts` (pro route),
  `packages/agent/src/slash-commands.ts` (pro command),
  `packages/core/test/pro-page/*`, `packages/agent/test/pro-command/*`,
  `docs/parity/evidence/LEM-155-pro-page-test-output.txt`

---

## Blockers

| Blocker | Impact | Unblock |
| --- | --- | --- |
| The lemma host surfaces for Codex, Antigravity, and Cursor are not yet verified against current host APIs. | `LEM-103`–`LEM-105` estimates and capability rows are provisional. | Spike each host's plugin/command/MCP surface during `LEM-099`; record the result in `docs/architecture.md` and the compatibility matrix. |
| No npm organization or publish credentials exist yet. | `LEM-134` cannot complete end-to-end provenance publishing. | Create the npm org/scope and a provenance-enabled publish token before Phase G. |
| No Chromium is guaranteed in the local environment. | Browser parity runs may be `blocked` locally. | Add the browser CI leg in `LEM-133`; until then record blocked coverage, never a pass. |
| No labeled historical release corpus is available. | Calibration can reproduce assay fixtures but cannot claim empirical validity. | Port assay's 14 fixtures now; curate real labeled releases before making a calibration claim. |
| assay is still the oracle and will keep changing. | Parity can drift during migration. | Pin the assay commit in `LEM-002`/`LEM-005`; re-baseline deliberately and record the new commit. |
| No local web server/token-auth pattern exists yet for the dashboard. | LEM-143–LEM-147 cannot ship until the serving pattern is chosen and reviewed. | Spike a localhost-only, token-protected static server during LEM-143; record the decision in `docs/adr/`. |

## Decision Log

| ID | Date | Decision | Rationale | Revisit |
| --- | --- | --- | --- | --- |
| DL1 | 2026-11-14 | `lemma` is a TypeScript/ESM monorepo with a host-neutral core and thin adapters. | The distribution goal is one installable plugin per host; five copies of the engine would drift. | If a host requires a non-Node runtime, add an adapter bridge rather than forking the core. |
| DL2 | 2026-11-14 | `assay` remains the behavioral oracle until `LEM-139`. | Parity must be measurable, not asserted. The Python implementation is the only complete reference. | Retire the oracle after the signed parity audit and a stable lemma release. |
| DL3 | 2026-11-14 | State root becomes `.lemma/`, with an explicit read shim for `.harness/`. | Product rename should not strand existing runs or evidence. | Remove the shim one major version after 1.0. |
| DL4 | 2026-11-14 | `@lemma/core` may depend on zod and a small YAML parser; everything else is optional or a peer dependency. | Typed contracts and workflow parsing are foundational; Playwright, host SDKs, and cloud SDKs are not. | Replace a dependency if it grows a transitive tree or a security issue. |
| DL5 | 2026-11-14 | The core never imports a host SDK; adapters depend on a single `AgentHost` contract with capability negotiation. | Keeps host churn out of the engine and makes missing capabilities explicit. | Split the interface if one host needs a capability no other host can model. |
| DL6 | 2026-11-14 | The 59 named assay commands are preserved as a catalog, but category commands must resolve to a deterministic check or a documented no-op. | A command that only renames a prompt is not product behavior; parity requires evidence or an explicit limitation. | Add category-specific checks only when a deterministic rule exists. |
| DL7 | 2026-11-14 | OpenCode and Claude Code are the first two adapters; Codex, Antigravity, and Cursor follow the same conformance kit. | They are the immediate shipping targets named by the product goal. | Promote another host earlier if a design partner requires it. |
| DL8 | 2026-11-14 | Optional browser and cloud capability ship as subpath exports/peer dependencies, never required installs. | A core install must work in an air-gapped CI with no Chromium and no cloud account. | Bundle a lightweight browser only if install friction becomes the larger cost. |
| DL9 | 2026-11-14 | The default score remains `weighted-coverage-v1`; no model may set or adjust it. | The score must be explainable and reproducible across hosts. | Revisit only with a labeled corpus that justifies a new formula version. |
| DL10 | 2026-11-14 | Every adapter ships a capability manifest and passes the shared conformance kit before it is documented as supported. | "Works on my host" is not a support claim. | Add richer conformance levels if host surfaces diverge further. |
| DL11 | 2026-11-14 | LEM-003 architecture/package graph/adapter contract ratified; operator sign-off recorded. | `docs/architecture.md` (ratified) and `docs/adr/0001-typescript-monorepo-and-contracts.md` lock dependency direction, host-neutral `AgentHost` contract, capabilities/degradation, and optionality boundaries; OpenCode and Claude Code named as first-ship adapters with explicit package owners. | Revisit via ADR/Decision Log if host surfaces or dependency boundaries materially change. |
| DL12 | 2026-11-15 | The functional persona frontmatter owns the 52 lemma-only `static.category.<label>` scope markers; catalog definitions keep `persona: ""`. | LEM-037 added intent-gated documented-no-op category scope checks that assay's 24-check catalog does not have. Frontmatter must remain the only ownership source (D16), and every check must have exactly one owner, so the generalist functional contract declares the scope markers while the three assay bodies/schemas stay unchanged. | Move scope markers out of the persona-owned catalog if a distinct planner-owned scope record contract replaces them. |
| DL13 | 2026-11-15 | Finding payload extraction, schema validation, quarantine, and contract-health accounting live in `@lemma/core/findings`, not in the orchestrator. | The orchestrator is a phase/state machine with host-neutral handlers; keeping the quarantine rules in a pure module lets the future CLI/agent execution path reuse them and keeps the deterministic behavior testable without a plugin loader. The package graph is unchanged. | Fold the module into `models` or `orchestrator` only if the execution loop becomes the sole caller. |
| DL14 | 2026-11-15 | Check outcome application and structured blocker/refusal records live in `@lemma/core/outcomes` (and the `@lemma/core/outcomes` subpath), reusing `findings` for non-blocked finding validation. | Blocker recording is a deterministic contract (one per check, no findings, redaction, schema validation) shared by future CLI/agent/plugin execution paths; a dedicated module keeps refusal semantics testable and host-neutral. | Merge into `findings` if outcome/finding/refusal responsibilities converge. |
| DL15 | 2026-11-15 | The CARBON-parity UX work is a new gate (G2.5) inside the delivery phases, not a post-1.0 addendum. | "Lemma as good as CARBON" requires the conversational manager, dashboard, HTML export, screenshots, journey maps, bug-hunting workflow, and dynamic a11y to ship alongside the deterministic core — otherwise lemma matches assay, not CARBON. | Re-scope into a separate product line only if UX scope pressure threatens the deterministic-core release date. |
| DL16 | 2026-11-15 | The dashboard runs locally on `127.0.0.1` with token auth and no remote dependency. | The privacy-first, local-first posture must extend to visual reporting; a remote host would contradict DL8 and the assay privacy model. | Move to a hosted dashboard only if a customer explicitly requires it and privacy review signs off. |

## Done

- **LEM-001** — Initialize the pnpm/TypeScript monorepo and quality gates (2026-11-14). Evidence: `pnpm install && pnpm lint && pnpm typecheck && pnpm build && pnpm test` passed; 11 workspace package shells, strict TS/ESM config, CI workflow (Node 20/22), and required repo docs/config present. Commit/remote recorded in completion summary.
- **LEM-002** — Publish the machine-readable assay parity manifest and check (2026-11-14). Evidence: `docs/parity/assay.manifest.json` (281 assets, 10 kinds), `scripts/parity/check.mjs` (`pnpm parity:check`), CI step, and parity drift/validation tests; `pnpm parity:check` exit 0 on complete manifest and nonzero on removed owner. Commit/remote recorded in completion summary.
- **LEM-003** — Ratify the architecture, package graph, and adapter contract (2026-11-14). Evidence: `docs/architecture.md` ratified (graph/module map/`AgentHost` interfaces/capability matrix/degradation/adapter ownership, OpenCode+Claude Code first), `docs/adr/0001-typescript-monorepo-and-contracts.md`, `packages/core/test/dependency-direction.test.ts`; `pnpm typecheck` and dependency-direction test passed. Operator sign-off: DL11. Commit/remote recorded in completion summary.
- **LEM-004** — Define versioned zod schemas and inferred core types (2026-11-14). Evidence: zod contract modules in `@lemma/core` for report v1, state/progress/history, evidence manifest, persona, plugin, policy, metering envelope/events, quota plan, price book, entitlement, queue job, billing record, retention; generated/committed `schemas/**` (23 files) match generator output; schema tests cover assay report compatibility (completed/halted/failed), contract rejection/additive fields. Commit/remote recorded in completion summary.
- **LEM-005** — Build the assay↔lemma golden parity harness (2026-11-14). Evidence: `pnpm test:parity` passes (oracle vs baselines, seeded/frozen zero-diff, field-level diff/self-check) for completed/halted/browser-blocked using `examples/sample-repo`; pinned oracle config, normalized baselines, harness script/docs, and CI parity step added. Commit/remote recorded in completion summary.
- **LEM-006** — Port deterministic clock, entropy, and seeded id providers (2026-11-14). Evidence: `packages/core/src/determinism.ts` and `packages/core/test/determinism/determinism.test.ts`; seeded/frozen byte-identical outputs, real UTC/random defaults, report-only `generated_at` override semantics, and typed validation errors verified (`pnpm --filter @lemma/core test -- determinism`). Commit/remote recorded in completion summary.
- **LEM-007** — Port the typed error model and exit-code contract (2026-11-14). Evidence: `packages/core/src/errors.ts`, `packages/cli/src/errors.ts`, `packages/core/test/errors/errors.test.ts`; typed domain errors, exit codes 0/1/2/3/130, stable malformed-workflow/corrupt-state payloads, JSON-only stdout/stderr separation verified (`pnpm --filter @lemma/core test -- errors`). Commit/remote recorded in completion summary.
- **LEM-008** — Port the redaction engine and synthetic corpus (2026-11-14). Evidence: `packages/core/src/redaction.ts`, `packages/core/test/redaction/fixtures/redaction-corpus.json` (30 shapes incl. Jira/storage state), `packages/core/test/redaction/redaction.test.ts`, `docs/parity/evidence/LEM-008-artifact-scan-output.json` (`leaked_count: 0`); idempotence, broken-redactor detection, and no-original-in-failure behavior verified (`pnpm --filter @lemma/core test -- redaction`). Commit/remote recorded in completion summary.
- **LEM-009** — Decide package naming, release flow, and consumer contracts (2026-11-14). Evidence: ADR 0002 (`@lemma/*` scope, `lemma` CLI, exports/optional browser+cloud subpaths, semver/Changesets/provenance, peer-dependency policy), updated package manifests, `.github/workflows/release-dry-run.yml`, `SECURITY.md`; `pnpm publish --dry-run --recursive --no-git-checks` passed for all workspace packages. Commit/remote recorded in completion summary.
- **LEM-010** — Port atomic state, JSON, and file-lock primitives (2026-11-14). Evidence: `packages/core/src/state.ts` (atomic write temp+fsync+rename, typed JSON read with `CorruptStateError`/`StateError`, advisory file lock with cross-process stale/crash recovery, `ensureDir`, kill-file write/read/clear), `packages/core/test/state/state.test.ts`; crash-injection and cross-process tests passed (`pnpm --filter @lemma/core test -- state`, 42/42). Cross-platform CI matrix added (`.github/workflows/ci.yml` `state-primitives` on ubuntu/macos/windows). Output: `docs/parity/evidence/LEM-010-state-test-output.txt`. Commit/remote recorded in completion summary.
- **LEM-011** — Port progress state, events, history, retention, and kill file (2026-11-14). Created acceptance criteria and delivered `StateStore` over `.lemma/` (progress save/load, JSONL events, versioned history record/upsert/sort, prune with protections/safe evidence removal, kill request/observe/clear) using shared primitives. Evidence: `packages/core/src/state-store.ts`, `packages/core/test/state/state-store.test.ts`, `docs/parity/evidence/LEM-011-state-store-test-output.txt` (`pnpm --filter @lemma/core test -- state`, 47/47). Commit/remote recorded in completion summary.
- **LEM-012** — Port the versioned workflow loader and phase invariant (2026-11-14). Created acceptance criteria and delivered dependency-free YAML subset workflow loader with typed validation/errors and fixed five-phase invariant. Evidence: `packages/core/src/workflows.ts`, `packages/core/test/workflows/workflows.test.ts`, `docs/parity/evidence/LEM-012-workflows-test-output.txt` (`pnpm --filter @lemma/core test -- workflows`, 52/52). Commit/remote recorded in completion summary.
- **LEM-013** — Port domain models, findings, and normalization (2026-11-14). Evidence: `packages/core/src/models.ts`, `packages/core/test/models/models.test.ts`, `docs/parity/evidence/LEM-013-models-test-output.txt` (`pnpm --filter @lemma/core test -- models`, 56/56). Commit/remote recorded in completion summary.
- **LEM-014** — Port the check catalog, registry, and intent planning (2026-11-14). Evidence: `packages/core/src/checks.ts`, `packages/core/test/checks/checks.test.ts`, `docs/parity/evidence/LEM-014-checks-test-output.txt` (`pnpm --filter @lemma/core test -- checks`, 60/60). Commit/remote recorded in completion summary.
- **LEM-015** — Port the five-phase orchestrator and budget (2026-11-14). Evidence: `packages/core/src/orchestrator.ts`, `packages/core/test/orchestrator/orchestrator.test.ts`, `docs/parity/evidence/LEM-015-orchestrator-test-output.txt` (`pnpm --filter @lemma/core test -- orchestrator`, 64/64). Commit/remote recorded in completion summary.
- **LEM-016** — Port the hashed evidence store and checkpoint manifest (2026-11-14). Evidence: `packages/core/src/evidence.ts`, `packages/core/test/evidence/evidence.test.ts`, `docs/parity/evidence/LEM-016-evidence-test-output.txt` (`pnpm --filter @lemma/core test -- evidence`, 68/68). Commit/remote recorded in completion summary.
- **LEM-017** — Port evidence signing, verification, and tamper hold (2026-11-14). Evidence: `packages/core/src/evidence.ts`, `packages/core/test/evidence/evidence-signing.test.ts`, `docs/parity/evidence/LEM-017-evidence-signing-test-output.txt` (`pnpm --filter @lemma/core test -- evidence-signing`, 3/3). Commit/remote recorded in completion summary.
- **LEM-018** — Port `weighted-coverage-v1` scoring (2026-11-14). Evidence: `packages/core/src/scoring.ts`, `packages/core/test/scoring/scoring.test.ts`, `docs/parity/evidence/LEM-018-scoring-test-output.txt` (`pnpm --filter @lemma/core test -- scoring`, 4/4). Commit/remote recorded in completion summary.
- **LEM-019** — Port versioned policy files and gate evaluation (2026-11-14). Evidence: `policies/advisory-v1.json`, `packages/core/src/scoring.ts`, `packages/core/test/policy/policy.test.ts`, `docs/parity/evidence/LEM-019-policy-test-output.txt` (`pnpm --filter @lemma/core test -- policy`, 4/4). Commit/remote recorded in completion summary.
- **LEM-020** — Port the report builder and JSON Schema validation (2026-11-14). Evidence: `packages/core/src/report.ts`, `schemas/report/report.v1.schema.json`, `packages/core/src/schemas/report.ts`, `packages/core/test/report/report.test.ts`, `docs/parity/evidence/LEM-020-report-test-output.txt` (`pnpm --filter @lemma/core test -- report`, 3/3). Commit/remote recorded in completion summary.
- **LEM-021** — Port resume, crash safety, and registry fingerprint (2026-11-14). Evidence: `packages/core/src/orchestrator.ts`, `packages/core/src/checks.ts`, `packages/core/test/resume/resume.test.ts`, `docs/parity/evidence/LEM-021-resume-test-output.txt` (`pnpm --filter @lemma/core test -- resume`, 3/3). Commit/remote recorded in completion summary.
- **LEM-022** — Port seeded resume and id-sequence continuity (2026-11-14). Evidence: `packages/core/src/determinism.ts`, `packages/core/src/orchestrator.ts`, `packages/core/test/seeded-resume/seeded-resume.test.ts`, `docs/parity/evidence/LEM-022-seeded-resume-test-output.txt` (`pnpm --filter @lemma/core test -- seeded-resume`, 3/3). Commit/remote recorded in completion summary.
- **LEM-023** — Port run history, retention, and prune (2026-11-14). Evidence: `packages/core/src/state-store.ts`, `packages/core/test/history/history.test.ts`, `docs/parity/evidence/LEM-023-history-test-output.txt` (`pnpm --filter @lemma/core test -- history`, 3/3; `test/state/state-store.test.ts`, 5/5). Commit/remote recorded in completion summary.
- **LEM-024** — Port risk analysis (2026-11-14). Evidence: `packages/core/src/risk.ts`, `packages/core/test/risk/risk.test.ts`, `docs/parity/evidence/LEM-024-risk-test-output.txt` (`pnpm --filter @lemma/core test -- risk`, 3/3). Commit/remote recorded in completion summary.
- **LEM-025** — Port the scenario step planner and runner (2026-11-14). Evidence: `packages/core/src/steps.ts`, `packages/core/test/steps/steps.test.ts`, `docs/parity/evidence/LEM-025-steps-test-output.txt` (`pnpm --filter @lemma/core test -- steps`, 3/3). Commit/remote recorded in completion summary.
- **LEM-026** — Build the orchestrator conformance suite (2026-11-14). Evidence: `packages/core/test/conformance/orchestrator-conformance.test.ts`, `docs/parity/evidence/LEM-026-conformance-test-output.txt` (`pnpm --filter @lemma/core test -- conformance`, 3/3). Commit/remote recorded in completion summary.
- **LEM-027** — Port source inventory and git-aware tracked/ignored scanning (2026-11-14). Evidence: `packages/core/src/static.ts`, `packages/core/test/inventory/inventory.test.ts`, `docs/parity/evidence/LEM-027-inventory-test-output.txt` (`pnpm --filter @lemma/core test -- inventory`, 3/3). Commit/remote recorded in completion summary.
- **LEM-028** — Port `.harnessignore`-equivalent scoping (2026-11-14). Evidence: `packages/core/src/static.ts`, `packages/core/test/harnessignore/harnessignore.test.ts`, `docs/parity/evidence/LEM-028-harnessignore-test-output.txt` (`pnpm --filter @lemma/core test -- harnessignore`, 4/4). Commit/remote recorded in completion summary.
- **LEM-029** — Port inventory, tests, CI, and dependency checks (2026-11-14). Evidence: `packages/core/src/static.ts`, `packages/core/test/static-checks/static-checks.test.ts`, `docs/parity/evidence/LEM-029-static-checks-test-output.txt` (`pnpm --filter @lemma/core test -- static-checks`, 6/6). Commit/remote recorded in completion summary.
- **LEM-030** — Port the accessibility markup scan (2026-11-14). Evidence: `packages/core/src/static.ts`, `packages/core/test/accessibility-scan/accessibility-scan.test.ts`, `docs/parity/evidence/LEM-030-accessibility-scan-test-output.txt` (`pnpm --filter @lemma/core test -- accessibility-scan`, 3/3). Commit/remote recorded in completion summary.
- **LEM-031** — Port secret scanning and precision rules (2026-11-14). Evidence: `packages/core/src/static.ts`, `packages/core/test/secret-scan/secret-scan.test.ts`, `docs/parity/evidence/LEM-031-secret-scan-test-output.txt` (`pnpm --filter @lemma/core test -- secret-scan`, 5/5). Commit/remote recorded in completion summary.
- **LEM-032** — Port unsafe-code rules (2026-11-14). Evidence: `packages/core/src/static.ts`, `packages/core/test/unsafe-scan/unsafe-scan.test.ts`, `docs/parity/evidence/LEM-032-unsafe-scan-test-output.txt` (`pnpm --filter @lemma/core test -- unsafe-scan`, 4/4). Commit/remote recorded in completion summary.
- **LEM-033** — Port baseline category checks (test/functionality/browser/issues/demo/more) (2026-11-14). Evidence: `packages/core/src/static.ts`, `packages/core/test/category-checks/category-checks.test.ts`, `docs/parity/evidence/LEM-033-category-checks-test-output.txt` (`pnpm --filter @lemma/core test -- category-checks`, 5/5). Commit/remote recorded in completion summary.
- **LEM-034** — Port full-assessment markers (2026-11-14). Evidence: `packages/core/src/static.ts`, `packages/core/test/full-assessment/full-assessment.test.ts`, `docs/parity/evidence/LEM-034-full-assessment-test-output.txt` (`pnpm --filter @lemma/core test -- full-assessment`, 1/1). Commit/remote recorded in completion summary.
- **LEM-035** — Port CI root-scoping precision (2026-11-14). Evidence: `packages/core/src/static.ts`, `packages/core/test/ci-root-scoping/ci-root-scoping.test.ts`, `docs/parity/evidence/LEM-035-ci-root-scoping-test-output.txt` (`pnpm --filter @lemma/core test -- ci-root-scoping`, 3/3). Commit/remote recorded in completion summary.
- **LEM-036** — Port risk tracked-file parity (2026-11-14). Evidence: `packages/core/src/risk.ts`, `packages/core/test/risk-tracked-parity/risk-tracked-parity.test.ts`, `docs/parity/evidence/LEM-036-risk-tracked-parity-test-output.txt` (`pnpm --filter @lemma/core test -- risk-tracked-parity`, 3/3). Commit/remote recorded in completion summary.
- **LEM-037** — Cover the remaining 50+ category commands with owned checks or documented no-ops (2026-11-14). Evidence: `packages/core/src/checks.ts`, `packages/core/src/static.ts`, `packages/core/src/index.ts`, `packages/core/test/checks/checks.test.ts`, `packages/core/test/category-coverage/category-coverage.test.ts`, `docs/parity/evidence/LEM-037-category-coverage-test-output.txt` (`pnpm --filter @lemma/core test -- category-coverage` and `-- checks`, 7/7). Commit/remote recorded in completion summary.
- **LEM-038** — Port the sample-repo, demo-web, and static fixtures (2026-11-14). Evidence: `examples/sample-repo/`, `examples/demo-web/`, `tests/fixtures/redaction_corpus.json`, `docs/parity/evidence/LEM-038-fixtures-parity.txt` (fixture parity checks vs assay). Commit/remote recorded in completion summary.
- **LEM-039** — Build the static precision and recall corpus (2026-11-14). Evidence: `packages/core/test/static-precision-recall-corpus/corpus.json`, `packages/core/test/static-precision-recall-corpus/static-precision-recall.test.ts`, `docs/parity/evidence/LEM-039-static-precision-recall-test-output.txt` (`pnpm --filter @lemma/core test -- static-precision-recall`, 1/1). Commit/remote recorded in completion summary.
- **LEM-040** — Verify static finding-to-evidence linkage and report totals (2026-11-14). Evidence: `packages/core/test/static-linkage-totals/static-linkage-totals.test.ts`, `docs/parity/evidence/LEM-040-static-linkage-totals-test-output.txt` (`pnpm --filter @lemma/core test -- static-linkage-totals`, 1/1). Commit/remote recorded in completion summary.
- **LEM-041** — Port the persona frontmatter parser (2026-11-14). Evidence: `packages/core/src/personas.ts`, `packages/core/test/personas/personas.test.ts`, `docs/parity/evidence/LEM-041-personas-test-output.txt` (`pnpm --filter @lemma/core test personas`, 7/7). Commit/remote recorded in completion summary.
- **LEM-042** — Port output and blocker schema validation (2026-11-14). Evidence: `packages/core/src/personas.ts`, `packages/core/test/persona-schema/persona-schema-validation.test.ts`, `docs/parity/evidence/LEM-042-persona-schema-validation-test-output.txt` (`pnpm --filter @lemma/core test persona-schema`, 8/8). Commit/remote recorded in completion summary.
- **LEM-074** — Build policy and calibration regression coverage (2026-11-15). Evidence: `policies/advisory-v1.json` canonical policy alignment, `calibration/fixtures/` stability regression (schema/formula/ship-review-hold coverage, summary consistency, preserved intentional disagreement `source-only` with no unintended mismatches), and policy-calibration interaction/gate override + invalid-policy rejection coverage in `packages/core/test/policy-calibration-regression/policy-calibration-regression.test.ts`, `docs/parity/evidence/LEM-074-policy-calibration-regression-test-output.txt` (`pnpm exec vitest run packages/core/test/policy-calibration-regression/policy-calibration-regression.test.ts`, 3/3). `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass. Parity inventory updated (LEM-074). Commit/remote recorded in completion summary.
- **LEM-073** — Build report-schema compatibility and contract tests (2026-11-15). Evidence: `packages/core/test/report/report-contract.test.ts` (published `schemas/report/report.v1.schema.json`/`schemas/report/index.json` alignment, schema-version enum contract, built report validation across normal/halted/failed/ship paths, additive compatibility, required-field removal/retype rejection, and parity-critical decision/confidence/coverage/metering-incl-run-scoped/trend/policy/contract-failures/limitations shapes), `docs/parity/evidence/LEM-073-report-contract-test-output.txt` (`pnpm exec vitest run packages/core/test/report/report-contract.test.ts`, 2/2). `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass. Parity inventory updated (LEM-073). Commit/remote recorded in completion summary.
- **LEM-072** — Port run-scoped and sink-wide metering summaries (2026-11-15). Evidence: `packages/core/src/metering.ts` (`summarizeMeteringEvents`/`summarizeMeteringSink`/`readMeteringEvents` with idempotency-key dedupe, deterministic event-type ordering, and parity sink-wide `event_count`/`event_types` plus run-scoped `run_event_count`/`run_event_types`), exports/index wiring, `packages/core/test/metering/metering-summary.test.ts`, `docs/parity/evidence/LEM-072-metering-summary-test-output.txt` (`pnpm exec vitest run packages/core/test/metering/metering-summary.test.ts`, 3/3). `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass. Report metering normalization remains compatible. Commit/remote recorded in completion summary.
- **LEM-071** — Port `verify-evidence` and the hold-on-tamper behavior (2026-11-15). Evidence: `packages/core/src/evidence.ts` (`verifyEvidence` offline manifest/artifact verification with run-id resolution, parity tamper/affected reporting, and hold-on-tamper `confidence_cap: 0.0`/`decision: "hold"`), exports/index wiring, `packages/core/test/evidence/verify-evidence.test.ts`, `docs/parity/evidence/LEM-071-verify-evidence-test-output.txt` (`pnpm exec vitest run packages/core/test/evidence/verify-evidence.test.ts`, 4/4). `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass. Parity inventory updated (CLI command pending LEM-085). Commit/remote recorded in completion summary.
- **LEM-070** — Port labeled calibration fixtures and `calibrate` (2026-11-15). Evidence: `calibration/fixtures/` (14 labeled ship/review/hold fixtures), `packages/core/src/calibration.ts` (`loadCalibrationFixtures`/`runCalibration`/`writeCalibrationReport`, parity-aligned decision derivation, schema `quality-harness.calibration/v1`/formula `weighted-coverage-v1`), exports/index wiring, `packages/core/test/calibration/calibration.test.ts`, `docs/parity/evidence/LEM-070-calibration-test-output.txt` (`pnpm exec vitest run packages/core/test/calibration/calibration.test.ts`, 3/3). `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass. Parity inventory updated (CLI command pending LEM-085). Commit/remote recorded in completion summary.
- **LEM-069** — Port baseline suppression with owner and expiry (2026-11-15). Evidence: `packages/core/src/suppressions.ts` (`SuppressionStore` persisted under `.lemma/suppressions.json` with schema/validation/active-expired classification, audit events to `.lemma/events.jsonl`, and `applySuppressionsToFindings`/expired-suppression finding semantics), exports/index wiring, `packages/core/test/suppression/suppression.test.ts`, `docs/parity/evidence/LEM-069-suppression-test-output.txt` (`pnpm exec vitest run packages/core/test/suppression/suppression.test.ts`, 4/4). `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass. Parity inventory updated (CLI commands pending LEM-085). Commit/remote recorded in completion summary.
- **LEM-068** — Port run-to-run trend diff (2026-11-15). Evidence: `packages/core/src/trends.ts` (`computeTrendDiff` with baseline/previous-run selection for same target, sorted new/resolved/persistent fingerprint diffs, rounded `score_delta`, explicit `coverage_delta` 0.0), exports/index wiring, `packages/core/test/trends/trend.test.ts`, `docs/parity/evidence/LEM-068-trend-diff-test-output.txt` (`pnpm exec vitest run packages/core/test/trends/trend.test.ts`, 3/3). `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass. Parity inventory updated. Commit/remote recorded in completion summary.
- **LEM-067** — Port report signing and verification (2026-11-15). Evidence: `packages/core/src/exports.ts` (`canonicalReportString`/`canonicalReportBytes`, `signReport`, `verifyReportSignature`, HMAC-SHA256 over canonicalized report JSON with constant-time verification), `packages/core/test/exports/report-signing.test.ts`, `docs/parity/evidence/LEM-067-report-signing-test-output.txt` (`pnpm exec vitest run packages/core/test/exports/report-signing.test.ts`, 3/3). `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass. Parity inventory updated (CLI sign/verify commands pending LEM-085). Commit/remote recorded in completion summary.
- **LEM-066** — Port JUnit export (2026-11-15). Evidence: `packages/core/src/exports.ts` (`buildJunit`, JUnit XML testsuite/testcase mapping with parity-aligned counts/status elements and redaction), `packages/core/test/exports/junit.test.ts`, `docs/parity/evidence/LEM-066-junit-export-test-output.txt` (`pnpm exec vitest run packages/core/test/exports/junit.test.ts`, 2/2). `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass. Parity inventory updated (CLI `lemma junit` pending LEM-085). Commit/remote recorded in completion summary.
- **LEM-065** — Port SARIF export (2026-11-15). Evidence: `packages/core/src/exports.ts` (`buildSarif`, SARIF 2.1.0 schema/version, quality-harness rules/results mapping, severity-level mapping, location/evidence relatedLocations, redaction), exports/index/package wiring (`@lemma/core/exports`), `packages/core/test/exports/sarif.test.ts`, `docs/parity/evidence/LEM-065-sarif-export-test-output.txt` (`pnpm exec vitest run packages/core/test/exports/sarif.test.ts`, 3/3). `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass. Parity inventory updated (CLI `lemma sarif` pending LEM-085). Commit/remote recorded in completion summary.
- **LEM-064** — Build the browser regression suite (2026-11-15). Evidence: `packages/browser/test/browser-regression-suite.test.ts` (deterministic/injected regression coverage for LEM-051 core checks, LEM-054 crawl discovery/merge metadata, LEM-055 overflow/focus_order contracts, and LEM-058 `browser.steps` pass/fail/blocked scenario outcomes), `docs/parity/evidence/LEM-064-browser-regression-suite-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-regression-suite.test.ts`, 7/7). `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Parity inventory updated. Commit/remote recorded in completion summary.
- **LEM-063** — Port browser defaults (crawl, mobile, headed, active) (2026-11-15). Evidence: `packages/browser/src/runtime.ts` (crawl max-pages default 5 when enabled/unset, mobile/headed/active option defaults and normalization/resolvers, mobile viewport default `390x844` when mobile without explicit viewport, Playwright launch/headless/context viewport+mobile hints), `packages/browser/test/browser-defaults.test.ts`, `docs/parity/evidence/LEM-063-browser-defaults-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-defaults.test.ts`, 5/5). `pnpm --filter @lemma/browser typecheck/build`, `pnpm lint`, and targeted crawl/runtime/viewport regressions pass. Parity inventory updated. Commit/remote recorded in completion summary.
- **LEM-062** — Port viewport and check metadata contracts (2026-11-15). Evidence: `packages/browser/src/runtime.ts`, `packages/browser/src/checks.ts` (runtime/options viewport resolution for Playwright capture, `metadata.viewport` `WxH` contract attached to browser outcomes incl. blocked/not-implemented/steps and injected/direct-evaluator paths, crawl/merged outcomes preserve viewport + crawl metadata, overflow/focus metadata preserved), `packages/browser/test/browser-viewport-metadata.test.ts`, `docs/parity/evidence/LEM-062-browser-viewport-metadata-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-viewport-metadata.test.ts`, 4/4). `pnpm --filter @lemma/browser typecheck/build`, `pnpm lint`, and targeted existing browser regressions (crawl/mobile/runtime/checks) pass. Claimed out of priority order vs unblocked higher-priority `LEM-063`/`LEM-064` at explicit user request. Parity inventory updated. Commit/remote recorded in completion summary.
- **LEM-061** — Verify browser evidence, manifest, and report linkage (2026-11-15). Evidence: `packages/browser/test/browser-evidence-linkage.test.ts` (skippable local Playwright+Chromium integration against `examples/demo-web/`: `runBrowserChecks` + core `EvidenceStore` capture/save, finalized manifest with portable `.lemma/evidence/<run_id>/` artifact entries/hashes, manifest verify clean, browser check `evidence` refs preserved via `recordCheckOutcome`, and `buildReport` check/report evidence refs + `evidence.directory`/`summary` consistent with manifest), `docs/parity/evidence/LEM-061-browser-evidence-linkage-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-evidence-linkage.test.ts`, 1/1; executed in this environment); parity inventory `harness/browser.py` row updated (LEM-061). `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-060** — Port browser fixtures and the CI smoke/blocked legs (2026-11-15). Evidence: `examples/demo-web/` (assay-parity fixture), `packages/browser/test/browser-smoke-leg.test.ts` (skippable local Playwright+Chromium smoke: serves demo-web, non-blocked `browser.load`, screenshot/console/network evidence), `packages/browser/test/browser-blocked-leg.test.ts` (disabled/unavailable runtime blocked-degradation, no false pass), `docs/parity/evidence/LEM-060-browser-legs-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-smoke-leg.test.ts packages/browser/test/browser-blocked-leg.test.ts`, 3/3; smoke executed in this environment); `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Claimed out of P0-priority order vs unblocked `LEM-061` at explicit user request. Commit/remote recorded in completion summary.
- **LEM-059** — Port SSRF-safe target validation and allowlists (2026-11-15). Evidence: `packages/core/src/ssrf.ts`, `packages/core/src/ssrf-export.ts`, `packages/core/src/index.ts`, `packages/core/package.json` (`validateUrl`/`validateRedirectChain`/`isSafeUrl`/`loadAllowlist`, injectable resolver, default blocked hosts/ranges, hostname/CIDR allowlists and env/file/root loading, per-call rebinding checks, redirect-chain revalidation, non-leaking `SsrfError`), `packages/core/test/ssrf/ssrf.test.ts`, `docs/parity/evidence/LEM-059-ssrf-test-output.txt` (`pnpm --filter @lemma/core test -- packages/core/test/ssrf/ssrf.test.ts`, 8/8 with pre-existing unrelated core schema-suite failures in full run); `pnpm --filter @lemma/core typecheck` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-058** — Port scenario-file execution and `browser.steps` (2026-11-15). Evidence: `packages/browser/src/scenarios.ts`, `packages/browser/src/runtime.ts`, `packages/browser/src/checks.ts`, `packages/browser/src/index.ts` (scenario plan loading/compilation, Playwright-driven `executeScenarioPlan`, `browser.steps` runtime integration/evaluation with injected execution/page support and blocked degradation), `packages/browser/test/browser-scenarios.test.ts`, `docs/parity/evidence/LEM-058-browser-steps-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-scenarios.test.ts`, 5/5; browser suite 48/48); `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-057** — Port HAR, trace, and video capture with redaction (2026-11-15). Evidence: `packages/browser/src/capture.ts` and `packages/browser/src/runtime.ts` (capture flags, Playwright HAR/trace/video recording/finalization, redacted HAR/trace-zip/video persistence with evidence refs and cleanup; common capture refs in `packages/browser/src/checks.ts`), `packages/browser/test/browser-capture-artifacts.test.ts`, `docs/parity/evidence/LEM-057-browser-capture-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-capture-artifacts.test.ts`, 4/4; browser suite 43/43); `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-056** — Port authenticated storage-state injection (2026-11-15). Evidence: `packages/browser/src/runtime.ts` (`resolveBrowserStorageState`, `storageState`/`storage_state` options, assay-compatible env/file/validation/expiry/empty handling, Playwright context injection without persisting resolved state, blocked degradation on resolution failure), `packages/browser/test/browser-storage-state.test.ts`, `docs/parity/evidence/LEM-056-browser-storage-state-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-storage-state.test.ts`, 6/6; browser suite 39/39); `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-055** — Port the responsive/mobile pack (overflow, focus order) (2026-11-15). Evidence: `packages/browser/src/checks.ts` (`browser.overflow` viewport-aware horizontal overflow/offending-element evaluator and `browser.focus_order` positive-tabindex/focus-order-match evaluator with runtime integration), `packages/browser/test/browser-mobile-pack.test.ts`, `docs/parity/evidence/LEM-055-browser-mobile-pack-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-mobile-pack.test.ts`, 6/6; browser suite 33/33); `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-054** — Port the bounded same-origin crawl (2026-11-15). Evidence: `packages/browser/src/checks.ts` and `packages/browser/src/runtime.ts` (`discoverRoutes`/route normalization with bounded seed-only same-origin crawl exclusions, multi-route `evaluateBrowserCheckAcrossViews`/merge with `crawled`/`page_count`/`routes`/`routes_not_evaluated` metadata and navigation-failed-route handling, runtime crawl inputs/injected views and best-effort Playwright crawl capture), `packages/browser/test/browser-crawl.test.ts`, `docs/parity/evidence/LEM-054-browser-crawl-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-crawl.test.ts`, 5/5; browser suite 27/27); `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-053** — Port the browser accessibility check (2026-11-15). Evidence: `packages/browser/src/checks.ts` (`browser.accessibility` evaluator: missing alt, unlabeled form controls with excluded types, unnamed controls, duplicate ids, positive tabindex, missing lang, `manual_review_required` metadata, runtime integration), `packages/browser/test/browser-accessibility.test.ts`, `docs/parity/evidence/LEM-053-browser-accessibility-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-accessibility.test.ts`, 5/5; browser suite 22/22); `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-052** — Port the browser security check (2026-11-15). Evidence: `packages/browser/src/checks.ts` (`browser.security` evaluator: HTTPS/transport, baseline headers with HSTS/CSP-or-report-only/frame-ancestors/Referrer-Policy, mixed content/insecure forms, weak session-like cookies, runtime integration), `packages/browser/test/browser-security.test.ts`, `docs/parity/evidence/LEM-052-browser-security-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-security.test.ts`, 6/6; browser suite 17/17); `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-051** — Port load, console, network, content, and link checks (2026-11-15). Evidence: `packages/browser/src/checks.ts` and `packages/browser/src/runtime.ts` (assay-parity evaluators for `browser.load`/`browser.console`/`browser.network`/`browser.content`/`browser.links`, navigation-failure blocking, implemented-vs-unsupported runtime integration with injected/captured views), `packages/browser/test/browser-checks.test.ts`, `docs/parity/evidence/LEM-051-browser-checks-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-checks.test.ts`, 8/8; runtime regression 3/3); `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-050** — Add the optional Playwright runtime and blocked degradation (2026-11-15). Evidence: `packages/browser/src/runtime.ts` and `packages/browser/src/index.ts` (optional Playwright probe/load, `BrowserUnavailableError`, `runBrowserChecks`/`degradeBrowserChecks`/`blockedBrowserOutcome` emitting one blocked outcome+blocker per browser check with no findings when runtime unavailable/disabled), `packages/browser/test/browser-runtime.test.ts`, `docs/parity/evidence/LEM-050-browser-runtime-test-output.txt` (`pnpm exec vitest run packages/browser/test/browser-runtime.test.ts`, 3/3); `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass. Commit/remote recorded in completion summary.
- **LEM-049** — Port tool capability enforcement and persona conformance tests (2026-11-15). Evidence: `packages/core/src/personas.ts` (`TOOL_CAPABILITY_PATTERN`, `validatePersonaToolCapabilities`, load-time enforcement), `packages/core/test/persona-conformance/persona-conformance.test.ts`, `docs/parity/evidence/LEM-049-persona-conformance-test-output.txt` (`pnpm --filter @lemma/core test persona-conformance`, 5/5); shipped specialists conform to schema/tool/ownership/catalog invariants under lemma's full 76-check catalog. Commit/remote recorded in completion summary.
- **LEM-048** — Port `personas scaffold` (2026-11-15). Evidence: `packages/core/src/personas.ts` (`scaffoldPersona`, validation/template/atomic-write and `quality-harness.personas.scaffold/v1` results), `packages/core/test/persona-scaffold/persona-scaffold.test.ts`, `docs/parity/evidence/LEM-048-persona-scaffold-test-output.txt` (`pnpm --filter @lemma/core test persona-scaffold`, 4/4); scaffolded contracts load and lint with expected placeholder warning. Commit/remote recorded in completion summary.
- **LEM-047** — Port `personas lint` (2026-11-15). Evidence: `packages/core/src/personas.ts` (`lintPersonas`, assay-compatible lint report/types/codes for load/schema/ownership/registry/placeholder diagnostics), `packages/core/test/persona-lint/persona-lint.test.ts`, `docs/parity/evidence/LEM-047-persona-lint-test-output.txt` (`pnpm --filter @lemma/core test persona-lint`, 4/4). Commit/remote recorded in completion summary.
- **LEM-046** — Port structured blocker and refusal records (2026-11-15). Evidence: `packages/core/src/outcomes.ts` (`blockerPayload`, `unblockHints`, `recordBlockedCheck`, `recordCheckOutcome`), `@lemma/core/outcomes` export/build wiring, `packages/core/test/blockers/blockers.test.ts`, `docs/parity/evidence/LEM-046-blockers-test-output.txt` (`pnpm --filter @lemma/core test blockers`, 6/6); blocked outcomes now produce one redacted blocker with no findings, forced-blocked refusals, dedupe, hints, and report/coverage integration verified. Commit/remote recorded in completion summary.
- **LEM-045** — Port invalid-finding quarantine and degraded streaks (2026-11-15). Evidence: `packages/core/src/findings.ts` (`draftPayload`, `findingFromPayload`, `quarantineFinding`, `recordValidContract`, `rebuildContractHealth`, `recordCheckFindings`), `packages/core/src/orchestrator.ts` (resume rebuild uses the shared helper), `packages/core/test/invalid-findings/invalid-findings.test.ts`, `docs/parity/evidence/LEM-045-invalid-findings-test-output.txt` (`pnpm --filter @lemma/core test invalid-findings`, 7/7); report/model invalid-finding fields and redaction verified end to end. Commit/remote recorded in completion summary.
- **LEM-044** — Port ownership derivation and disjointness enforcement (2026-11-15). Evidence: `packages/core/src/personas.ts` (ownership helpers), `packages/core/src/checks.ts` (shared planner message), `packages/personas/functional.md` (52 lemma-only scope checks), `packages/core/test/ownership/ownership.test.ts`, `docs/parity/evidence/LEM-044-ownership-test-output.txt` (`pnpm --filter @lemma/core test ownership`, 10/10), `docs/parity/evidence/LEM-044-functional-contract-extension.txt` (only additive frontmatter diff vs assay). Commit/remote recorded in completion summary.
- **LEM-043** — Port the functional, security, and accessibility contracts (2026-11-15). Evidence: `packages/personas/{functional,security,accessibility,README}.md`, `packages/core/src/personas.ts`, `packages/core/test/persona-contracts/persona-contracts.test.ts`, `docs/parity/evidence/LEM-043-persona-contracts-test-output.txt` (`pnpm --filter @lemma/core test persona-contracts`, 7/7), `docs/parity/evidence/LEM-043-assay-persona-diff.txt` (all four files byte-identical to assay). Commit/remote recorded in completion summary.

### LEM-075 — Port the signed plugin registry

- **Epic:** E7 Plugins and Extensibility
- **Priority:** P0
- **Points:** 8
- **Depends on:** LEM-014
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/plugins/plugins-registry.test.ts`.
- **Description:** Port the signed check plugin registry in core: builtin
  registration, plugin discovery/loading, HMAC-SHA256 signature verification
  against a local trust store, definition validation, and blocked
  definitions/reasons for plugins that cannot be imported, validated, or
  verified (parity-aligned semantics; execution context/ownership integration
  follow in LEM-076/LEM-077).
- **Acceptance Criteria:**
  - `@lemma/core` provides a plugin registry API (e.g. `CheckRegistry`,
    `buildRegistry`, `loadTrustKeys`, `signaturePayload`, `signPlugin`, entry-
    point loading helpers) that registers built-in checks and discovered plugin
    checks through the same registry surface (ids/definitions/source/evaluator
    lookup, builtin/plugin/blocked counts, blocked reasons/owner hints).
  - Plugin definitions are validated (e.g. stable check id format, known
    requires/input kinds, supported plugin kinds, non-zero/valid weight, no
    duplicate ids) and plugin signatures are verified with HMAC-SHA256 over the
    canonical definition/entry-point payload using keys from the trust store
    (e.g. `.lemma/plugins/trusted_keys.json` or compatible path/config); a
    trusted key must be present for verification.
  - A plugin that cannot be imported, loaded, validated, or signature-verified
    does not fail the run/build: it becomes a registered blocked definition with
    an actionable blocked reason/source/owner hint (coverage gap), not a pass.
    Unsigned or wrongly-signed plugins are rejected/blocked; correctly signed
    plugins with trusted keys register successfully.
  - Registry state is deterministic and compatible with existing planning/
    fingerprinting hooks (ids/order/fingerprint inputs stable for same inputs);
    builtins remain discoverable through the registry.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/plugins/plugins-registry.test.ts`
    pass in this environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/core typecheck` (pass), `pnpm --filter @lemma/core build` (pass), `pnpm exec vitest run packages/core/test/plugins/plugins-registry.test.ts` (pass, 4 tests).
- **Evidence:** `packages/core/src/plugins.ts`, `packages/core/src/index.ts` (exports), `packages/core/src/checks.ts` (`registryFingerprint` prefers concrete registry fingerprint when available), `packages/core/test/plugins/plugins-registry.test.ts`, `docs/parity/evidence/LEM-075-plugin-registry-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`. Correctly signed plugins register; unsigned/unknown-key/invalid-signature/import/discovery failures become blocked `plugin-blocked` definitions with actionable reasons (no run/build failure); trust store at `.lemma/plugins/trusted_keys.json` by default. Execution context wiring and ownership validation remain in LEM-076/LEM-077.

### LEM-076 — Port the plugin context and blocked-failure handling

- **Epic:** E7 Plugins and Extensibility
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-075
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/plugins/plugin-context.test.ts`.
- **Description:** Port the plugin execution context and failure handling so a
  broken, missing, or misbehaving plugin becomes a blocked coverage gap instead
  of a run failure.
- **Acceptance Criteria:**
  - `@lemma/core` provides a plugin execution context and runner (e.g.
    `PluginContext`, `PluginCheckRunner`) that exposes check/target/root/
    inventory/evidence/log surfaces to evaluators and a `saveJson` helper that
    persists evidence via `EvidenceStore` under the check and returns a run-
    relative evidence path suitable for `CheckOutcome.evidence`.
  - `PluginCheckRunner.run(...)` executes the evaluator with the bounded context
    and returns a `CheckOutcome`: evaluator crashes/exceptions become an ERROR
    outcome (not a fatal run failure); non-`CheckOutcome` returns, unknown check
    statuses, non-`FindingDraft` findings, non-`BlockerDraft` blockers, or
    invalid/unsafe evidence references produce ERROR outcomes with actionable
    messages.
  - Runner enforces evidence integrity for plugin outcomes: referenced evidence
    paths must resolve inside the run evidence directory and exist as files;
    finding evidence must be included in check evidence, and findings require
    evidence before they can be recorded.
  - Blocked-failure handling: core exposes helpers to produce blocked outcomes
    for blocked plugin checks/registry-blocked reasons (coverage gap, no
    evaluator execution), carrying an actionable boundary/blocker draft (not a
    pass/fatal). `PluginContext`/runner APIs are exported from `@lemma/core`.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/plugins/plugin-context.test.ts`
    pass in this environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/core typecheck` (pass), `pnpm --filter @lemma/core build` (pass), `pnpm exec vitest run packages/core/test/plugins/plugin-context.test.ts` (pass, 5 tests; `plugins-registry.test.ts` 4/4 still pass).
- **Evidence:** `packages/core/src/plugins.ts` (`PluginContext`, `PluginCheckRunner` with `saveJson`/crash+validation handling and run-evidence integrity checks, `blockedPluginOutcome`), `packages/core/src/index.ts` exports, `packages/core/test/plugins/plugin-context.test.ts`, `docs/parity/evidence/LEM-076-plugin-context-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`. Evaluator failures/misbehavior yield ERROR/blocked outcomes (coverage gaps) instead of fatal run failure; registry ownership/planning integration follows in LEM-077+.

### LEM-077 — Port plugin ownership validation

- **Epic:** E7 Plugins and Extensibility
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-044, LEM-075
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/plugins/plugin-ownership.test.ts`.
- **Description:** Validate that every plugin check is owned by exactly one
  persona and that blocked plugin checks are surfaced as blocked coverage gaps,
  not silent passes.
- **Acceptance Criteria:**
  - `CheckRegistry` in `@lemma/core/plugins` provides ownership validation (e.g.
    `validateOwnership(personas)`) that resolves registered check ids to persona
    owners using `checkOwnership`/`ownershipErrorMessage` semantics from persona
    frontmatter (D16).
  - For every registered builtin/non-plugin check, ownership must resolve to
    exactly one persona; zero or multiple owners throw a `PersonaError` with the
    deterministic ownership message (configuration error, fail validation before
    execution).
  - For plugin checks (including blocked `plugin`/`plugin-blocked` definitions),
    ownership failures (zero or multiple owners) do **not** throw: the registry
    marks/keeps the check blocked with the ownership reason and retains/sets an
    owner hint so it is surfaced as a blocked coverage gap (never a pass, never
    a fatal run failure). Already-blocked plugin checks remain blocked.
  - When a registered check has exactly one owner, validation succeeds; if the
    check is blocked and missing an owner hint, the registry records the owner
    hint.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/plugins/plugin-ownership.test.ts`
    pass in this environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/core typecheck` (pass), `pnpm --filter @lemma/core build` (pass), `pnpm exec vitest run packages/core/test/plugins/plugin-ownership.test.ts` (pass, 4 tests).
- **Evidence:** `packages/core/src/plugins.ts` (`CheckRegistry.validateOwnership` using `checkOwnership`/`ownershipErrorMessage`; builtin ownership errors throw `PersonaError`, plugin/`plugin-blocked` ownership failures block as coverage gaps with existing blocked reasons preserved and owner hint set for singly-owned blocked checks), `packages/core/test/plugins/plugin-ownership.test.ts`, `docs/parity/evidence/LEM-077-plugin-ownership-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`. Orchestrator/planning integration and conformance remain in later E7 tasks.

### LEM-078 — Define the TypeScript plugin authoring API

- **Epic:** E7 Plugins and Extensibility
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-075, LEM-076
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/plugins/plugin-authoring-api.test.ts`. Taken out of order vs unblocked P0 `LEM-079` (dep `LEM-075` done) at explicit user request.
- **Description:** Define the TypeScript API for authoring lemma check plugins
  (definition, evaluator/context, and signed plugin export shape) so third-party
  checks can be implemented against stable core types/helpers without depending
  on internal orchestrator details.
- **Acceptance Criteria:**
  - `@lemma/core` exports a stable plugin authoring surface (and a `./plugins`
    subpath export/build target) including `definePlugin(...)` (and/or
    definition helper) that constructs a typed `CheckPlugin` object with
    `definition`, `evaluate`, and optional `signature`, compatible with
    `CheckRegistry` loading/validation/signing and `PluginCheckRunner`.
  - Authoring types are exported for plugin authors: at minimum `CheckPlugin`,
    `PluginContext`, `PluginEvaluator`, plugin definition input/shape, and
    outcome/finding helpers or re-exports needed to return valid `CheckOutcome`
    results (including evidence via `context.saveJson`).
  - `definePlugin(...)` preserves/infers definition and evaluator typing,
    normalizes authoring input into a registry-compatible definition (stable id,
    kind/intent/expected/requires/base_weight/domain fields as required by
    validation/signing), and rejects or surfaces invalid authoring shapes in a
    deterministic, typed way consistent with existing plugin validation.
  - A plugin authored via the API can be registered with a trusted signature and
    executed by `PluginCheckRunner` to produce a valid `CheckOutcome` with
    evidence, demonstrating end-to-end authoring compatibility.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/plugins/plugin-authoring-api.test.ts`
    pass in this environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/core typecheck` (pass), `pnpm --filter @lemma/core build` (pass), `pnpm exec vitest run packages/core/test/plugins/plugin-authoring-api.test.ts` (pass, 3 tests).
- **Evidence:** `packages/core/src/plugins.ts` (`definePlugin`, `definePluginDefinition`, `PluginDefinitionInput`/`DefinePluginInput` and exported authoring types; deterministic normalization/validation aligned with registry), `packages/core/src/index.ts` export, `packages/core/package.json` + `@lemma/core/plugins` subpath build/export, `packages/core/test/plugins/plugin-authoring-api.test.ts`, `docs/parity/evidence/LEM-078-plugin-authoring-api-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`. End-to-end authored+signed+registered+executed plugin with `context.saveJson` evidence verified. Sample plugin/docs, trust-store helper split, and conformance remain in LEM-079–LEM-082.

### LEM-079 — Port the HMAC trust store and signing helper

- **Epic:** E7 Plugins and Extensibility
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-075
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/plugins/plugin-trust-store.test.ts`.
- **Description:** Port the HMAC-SHA256 plugin trust store and signing helper
  APIs used to manage trusted plugin signing keys and produce/verify detached
  plugin signatures outside core internals.
- **Acceptance Criteria:**
  - `@lemma/core` exports trust-store and signing helper APIs/constants
    (compatible with existing registry behavior): `PLUGIN_SIGNATURE_SCHEME`,
    `DEFAULT_PLUGIN_TRUST_FILE`, `resolvePluginTrustFile`, `loadTrustKeys`,
    `saveTrustKeys` (or equivalent write helper), `signaturePayload`,
    `signPlugin`, and signature parsing/verification helpers.
  - Trust store behavior: default path resolves under `.lemma/plugins/trusted_keys.json`;
    missing trust store loads as empty keys (not an error); malformed/unreadable
    stores are handled safely (warning/log hook path preserved, no crash) while
    valid stores load key id -> secret mappings from `{"keys":{...}}` (and
    compatible plain-object form as already supported).
  - `saveTrustKeys`/write helper persists a canonical `{"keys":...}` JSON trust
    store, creating parent directories as needed, so keys can be round-tripped
    via `loadTrustKeys`.
  - Signing helpers produce and verify HMAC-SHA256 detached signatures in the
    `hmac-sha256:<key_id>:<hex_digest>` format over the canonical plugin
    definition+entry-point payload; invalid formats or unknown/mismatched keys
    are rejected deterministically.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/plugins/plugin-trust-store.test.ts`
    pass in this environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/core typecheck` (pass), `pnpm --filter @lemma/core build` (pass), `pnpm exec vitest run packages/core/test/plugins/plugin-trust-store.test.ts` (pass, 3 tests).
- **Evidence:** `packages/core/src/plugins.ts` (`resolvePluginTrustFile`, `loadTrustKeys` with safe missing/malformed handling and `{"keys":...}`/plain-object compatibility, `saveTrustKeys` canonical round-trip write with parent-dir creation, `signaturePayload`, `signPlugin`, `parsePluginSignature`, `verifyPluginSignature`), `packages/core/test/plugins/plugin-trust-store.test.ts`, `docs/parity/evidence/LEM-079-plugin-trust-store-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`. CLI signing commands and sample docs remain in later tasks (LEM-080/LEM-085).

### LEM-080 — Publish the sample plugin and authoring docs

- **Epic:** E7 Plugins and Extensibility
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-076, LEM-078
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/plugins/sample-plugin-example.test.ts`.
- **Description:** Publish a signed-shape sample plugin example and authoring
  documentation adapted to lemma's TypeScript plugin API, trust store, and
  ownership/refusal contracts.
- **Acceptance Criteria:**
  - Add `examples/plugins/` containing a lemma sample plugin (TypeScript/ESM
    source) exporting an unsigned-by-default `PLUGIN` built with the
    `@lemma/core` authoring API (`definePlugin`/definition shape), a
    `package.json` showing the installable/package and entry-point shape, and a
    `README.md` with authoring, trust-store/signing (`.lemma/plugins/trusted_keys.json`,
    `resolvePluginTrustFile`/`saveTrustKeys`/`signPlugin`), ownership, and
    refusal/blocker guidance adapted to lemma.
  - The sample plugin uses `PluginContext`/`context.saveJson` and returns a valid
    `CheckOutcome` (or demonstrates refusal/blocker usage in docs) consistent
    with registry/runner contracts; its definition declares stable id, kind,
    requires, base_weight, intent/expected, and domain.
  - Automated verification demonstrates the sample can be loaded, signed with a
    trusted key, registered, and executed successfully (producing evidence and
    expected outcome) in this environment.
  - `docs/parity/assay-feature-inventory.md` rows for the sample plugin example
    files are updated with LEM-080 evidence; `BOARD.md` is updated with
    verification/evidence on completion.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/plugins/sample-plugin-example.test.ts`
    pass in this environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/core typecheck` (pass), `pnpm --filter @lemma/core build` (pass), `pnpm exec vitest run packages/core/test/plugins/sample-plugin-example.test.ts` (pass, 2 tests).
- **Evidence:** `examples/plugins/sample-check.ts` (unsigned-by-default `PLUGIN` via `definePlugin`, `context.saveJson`, manifest/evidence outcome), `examples/plugins/package.json` (installable/entry-point shape with `lemma.checks` hint), `examples/plugins/README.md` (authoring, `.lemma/plugins/trusted_keys.json` trust-store/signing, ownership, refusal/blocker guidance), `packages/core/test/plugins/sample-plugin-example.test.ts`, `docs/parity/evidence/LEM-080-sample-plugin-test-output.txt`, updated `docs/parity/assay-feature-inventory.md` (sample files + `harness/plugins.py`/`test_plugins.py` rows). `eslint.config.js` updated to ignore `examples/**` for type-aware lint. Conformance/resume remain in LEM-081–LEM-082.

### LEM-081 — Port resume protection against a changed plugin registry

- **Epic:** E7 Plugins and Extensibility
- **Priority:** P2
- **Points:** 3
- **Depends on:** LEM-021, LEM-075
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/plugins/plugin-resume-registry.test.ts`. Taken out of order vs unblocked P1 `LEM-082` (deps `LEM-075`–`LEM-077` done) at explicit user request.
- **Description:** Guard run resume against a changed plugin/check registry so
  pending work is never replayed against a different evaluator/trust/definition
  set.
- **Acceptance Criteria:**
  - Resume compares the saved registry fingerprint recorded for the run against
    the current registry fingerprint (including plugin registry state) and
    rejects with a `StateError` when they differ, before resuming/replaying
    work.
  - On a fingerprint mismatch, saved progress/state and evidence/manifest remain
    byte-identical (failed resume attempt is read-only and does not mutate run
    artifacts).
  - When the registry fingerprint is unchanged (including unchanged plugin
    registry), resume succeeds and preserves the run identity/fingerprint.
  - Protection covers plugin-registry changes that affect the fingerprint (e.g.
    added/removed plugin checks or changed trust/plugin state reflected in the
    registry fingerprint), consistent with `registryFingerprint`/`CheckRegistry`
    behavior.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/plugins/plugin-resume-registry.test.ts`
    pass in this environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/core typecheck` (pass), `pnpm --filter @lemma/core build` (pass), `pnpm exec vitest run packages/core/test/plugins/plugin-resume-registry.test.ts` (pass, 3 tests).
- **Evidence:** `packages/core/src/orchestrator.ts` (accepts `registry` in run/resume options for plugin-aware fingerprint computation/validation; existing mismatch guard rejects with `StateError` before replay), `packages/core/test/plugins/plugin-resume-registry.test.ts`, `docs/parity/evidence/LEM-081-plugin-resume-registry-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`. Unchanged plugin registry resumes with preserved identity; changed plugin set/trust state fingerprints are rejected without mutating progress or evidence. Conformance remains in LEM-082.

- **Epic:** E6 Reporting, Policy, and Exports
- **Priority:** P2
- **Points:** 3
- **Depends on:** LEM-019, LEM-070
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/policy-calibration-regression/policy-calibration-regression.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; policy/calibration regression tests 3/3 passed, plus `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass.
- **Description:** Add regression coverage guarding policy and calibration
  behavior together (canonical policy file, fixture calibration stability, and
  policy-driven scoring/gate interactions) to prevent drift from LEM-019/LEM-070
  parity baselines.
- **Acceptance Criteria:**
  - Regression tests verify the canonical `policies/advisory-v1.json` file loads
    as a valid `quality-harness.policy/v1` policy with expected id/version/gate
    and scoring defaults compatible with calibration's `weighted-coverage-v1`
    baseline.
  - Regression tests run calibration against `calibration/fixtures/` and assert
    stable parity-critical outcomes under the default policy (fixture count and
    ship/review/hold coverage, schema/formula, summary consistency, and preserved
    intentional disagreements / no unintended decision regressions).
  - Regression tests cover policy-calibration interaction cases (e.g. custom
    policy overrides changing gate/decision behavior in representative fixture or
    scoring scenarios, while invalid policies remain rejected) without weakening
    default calibration expectations.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/policy-calibration-regression/policy-calibration-regression.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/core/test/policy-calibration-regression/policy-calibration-regression.test.ts`
- **Evidence:** `policies/advisory-v1.json`, `calibration/fixtures/`, `packages/core/test/policy-calibration-regression/policy-calibration-regression.test.ts`, `docs/parity/evidence/LEM-074-policy-calibration-regression-test-output.txt`; parity inventory updated (LEM-074). Commit/remote recorded in completion summary.

### LEM-082 — Build the plugin conformance suite

- **Epic:** E7 Plugins and Extensibility
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-075, LEM-076, LEM-077
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/plugins/plugin-conformance.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass.
- **Description:** Build a conformance suite that verifies the end-to-end
  plugin contract (signed registry/loading, authoring API, execution context and
  runner, ownership validation, and blocked-failure handling) against lemma's
  deterministic plugin invariants.
- **Acceptance Criteria:**
  - Add `packages/core/test/plugins/plugin-conformance.test.ts` as the plugin
    conformance suite covering, at minimum: (1) signed plugin authoring/load
    success (trusted key + valid signature + registry registration + evaluator
    execution producing valid `CheckOutcome` with `context.saveJson` evidence);
    (2) unsigned/unknown-key/invalid-signature/tampered-definition plugins become
    blocked `plugin-blocked` coverage gaps (not passes, not fatal) with
    actionable reasons; (3) import/discovery/load failures become blocked
    coverage gaps without failing the run/build.
  - Suite verifies definition/registry contract conformance: stable id/validation
    rules, deterministic registry/fingerprint behavior for equivalent inputs,
    and correct source/evaluator/blocked/count semantics for builtin vs plugin
    vs blocked entries.
  - Suite verifies execution/ownership conformance: `PluginCheckRunner` context
    and outcome validation (crash → ERROR, invalid returns/status/drafts/unsafe
    or missing evidence and finding-evidence violations → ERROR), blocked plugin
    outcome helper semantics, and `CheckRegistry.validateOwnership` (builtin
    zero/multi-owner throws `PersonaError`; plugin ownership failures block as
    coverage gaps with hints preserved/set appropriately).
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/plugins/plugin-conformance.test.ts`
    pass in this environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/core typecheck` (pass), `pnpm --filter @lemma/core build` (pass), `pnpm exec vitest run packages/core/test/plugins/plugin-conformance.test.ts` (pass, 6 tests).
- **Evidence:** `packages/core/test/plugins/plugin-conformance.test.ts`, `docs/parity/evidence/LEM-082-plugin-conformance-test-output.txt`, updated `docs/parity/assay-feature-inventory.md` (`harness/plugins.py`, `test_plugins.py`). Conformance covers signed authoring/load/execution with `context.saveJson` evidence, blocked unsigned/unknown-key/invalid-signature/tampered/import-discovery/load failures as coverage gaps (non-fatal), definition/registry/fingerprint/count/source contracts, runner context/validation/crash/evidence/finding-evidence enforcement and blocked-outcome helper, and ownership validation (builtin throws, plugin blocked/hints).

### LEM-083 — Build the CLI shell, JSON-only stdout, and exit codes

- **Epic:** E8 CLI and Agent Core
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-007, LEM-015
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/cli/test/cli-shell.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass.
- **Description:** Implement the machine-first `@lemma/cli` shell with strict
  JSON-only stdout, stderr-only diagnostics, and deterministic exit-code mapping
  as the foundation for later command ports.
- **Acceptance Criteria:**
  - `@lemma/cli` exposes a working `lemma` binary entrypoint (`packages/cli/src/cli.ts`)
    and shell API (`main`/`dispatch`/command registry) that routes argv to
    registered command handlers and is extensible for LEM-084+ command ports.
  - Stdout is JSON-only for all shell invocations (no human prose): no-args/help
    (`--help`/`-h`/`help`) and version (`--version`/`-v`/`version`) emit usage/
    version JSON with exit `0`; known-command results emit JSON payloads; all
    failures emit structured error JSON payloads via core `toErrorPayload`.
    Diagnostics/progress are written to stderr only.
  - Exit codes follow core `EXIT_CODES`/`exitCodeForError`: `0` success/pass,
    `1` policy-threshold failures, `2` harness/usage errors (including unknown
    command and not-implemented shell commands), `3` kill-switch halt and `130`
    operator interrupt when represented by core error types.
  - Default registry includes LEM-084 command placeholders (`run`, `status`,
    `report`, `abort`, `prune`) that fail explicitly as not-implemented usage
    errors (structured JSON, exit `2`) until ported.
  - `pnpm lint`, `pnpm --filter @lemma/cli typecheck`,
    `pnpm --filter @lemma/cli build`, and
    `pnpm exec vitest run packages/cli/test/cli-shell.test.ts` pass in this
    environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/cli typecheck` (pass), `pnpm --filter @lemma/cli build` (pass), `pnpm exec vitest run packages/cli/test/cli-shell.test.ts` (pass, 6 tests).
- **Evidence:** `packages/cli/src/cli.ts`, `packages/cli/src/index.ts`, `packages/cli/test/cli-shell.test.ts`, `docs/parity/evidence/LEM-083-cli-shell-test-output.txt`, updated `docs/parity/assay-feature-inventory.md` (`harness/__main__.py`, `harness/cli.py`). Shell enforces JSON-only stdout (usage/version/dispatch/errors), stderr-only diagnostics, core exit-code/error-payload mapping, extensible command registry, and explicit not-implemented placeholders for `run/status/report/abort/prune` pending LEM-084.

### LEM-084 — Port `run`, `status`, `report`, `abort`, and `prune`

- **Epic:** E8 CLI and Agent Core
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-083
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/cli/test/cli-commands.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass.
- **Description:** Port core machine-first CLI commands for running and managing
  lemma runs (`run`, `status`, `report`, `abort`, and `prune`) on top of the LEM-083
  shell and existing core primitives.
- **Acceptance Criteria:**
  - `lemma run` accepts core args (`--target` required, `--root`, `--intent`,
    `--max-checks`, `--resume`, `--seed`, `--clock-mode`, `--frozen-clock`,
    `--output`, `--quiet`, `--keep-runs`, `--fail-on`, `--min-score`) and
    executes via core `Orchestrator`/`StateStore`/`EvidenceStore`/`buildReport`
    using the release-confidence workflow. Emits run progress/diagnostics to
    stderr only (unless `--quiet`) and prints exactly one JSON report object to
    stdout; optionally writes the same report to `--output`; applies optional
    post-run `--keep-runs` pruning. Exit `0` on pass, `1` when fail-on/min-score
    policy thresholds are violated, `3` for halted runs, `2` for failed/error
    runs.
  - `lemma status` with no progress state emits a JSON `no_run` payload (exit 0).
    With saved progress, emits a JSON summary including run/status/workflow/
    target/intent/phase/confidence, checks-by-status, findings-by-severity,
    blockers and blocker breakdowns, kill/halt fields, and state/report/progress
    paths. `--all` emits JSON history listing from `StateStore.loadHistory()`
    (runs/count/root).
  - `lemma report` loads latest saved progress and emits the built report JSON to
    stdout (exit 0). If no run/progress exists, returns a structured JSON error
    (exit 2).
  - `lemma abort` requests a kill (`StateStore.requestKill`), appends a
    `manual_kill_requested` event, and emits a JSON confirmation payload including
    reason/kill path/requested timestamp (exit 0).
  - `lemma prune` supports `--keep-runs`, `--older-than-days`, and `--dry-run`,
    invokes `StateStore.prune`, and emits a JSON result with status/root/removed/
    retained/count (exit 0). Stdout remains JSON-only and errors follow core
    shell exit/payload behavior.
  - `pnpm lint`, `pnpm --filter @lemma/cli typecheck`,
    `pnpm --filter @lemma/cli build`, and
    `pnpm exec vitest run packages/cli/test/cli-commands.test.ts` pass in this
    environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/cli typecheck` (pass), `pnpm --filter @lemma/cli build` (pass), `pnpm exec vitest run packages/cli/test/cli-shell.test.ts packages/cli/test/cli-commands.test.ts` (pass, 10 tests).
- **Evidence:** `packages/cli/src/commands.ts`, `packages/cli/src/index.ts`, `packages/cli/src/index-types.ts`, `packages/cli/src/cli.ts`, `packages/cli/test/cli-commands.test.ts` (shell test updated), `docs/parity/evidence/LEM-084-cli-commands-test-output.txt`, updated `docs/parity/assay-feature-inventory.md` (LEM-084 rows). Commands wired into default registry (replacing stubs), JSON-only stdout/stderr diagnostics and core exit/error mapping preserved.

### LEM-085 — Port persona, export, signing, suppression, calibration, and verify commands

- **Epic:** E8 CLI and Agent Core
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-065, LEM-066, LEM-067, LEM-069, LEM-070, LEM-071, LEM-083
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/cli/test/cli-commands-extended.test.ts`. Taken out of order vs unblocked higher-priority P0 `LEM-086` (deps `LEM-083`,`LEM-084` done) at explicit user request.
- **Completed:** 2026-11-15 — all acceptance criteria pass.
- **Description:** Port CLI command wiring for existing core persona/export/
  signing/suppression/calibration/evidence-verification capabilities.
- **Acceptance Criteria:**
  - `lemma personas` supports `list` (default), `lint`, and `scaffold <id>`
    actions using core persona APIs (`loadPersonas`/`lintPersonas`/`scaffoldPersona`
    or equivalent): JSON-only stdout with stable command payloads; `lint` exits 0
    when valid else 1; `scaffold` exits 0 on created/overwritten else 2; accepts
    `--root`/`--personas-dir` and relevant action flags (`--select`, `--name`,
    `--domain`, `--check`, `--force`).
  - Export/signing/report-verification commands wire to core APIs and latest
    saved report state: `sarif` and `junit` emit JSON stdout payloads (SARIF doc
    or written/path status; JUnit wrapped as JSON with `xml` content when not
    written) and support `--root`/`--output`; `sign-report` (`--root`/`--key`
    [/path or literal], optional `--output`) writes signature and emits JSON
    status/signature/path; `verify-report` (`--root`/`--key`, `--signature`
    value or path) emits JSON verified status and exits 0 valid / 1 invalid.
  - `lemma suppress`/`suppressions` support `add`, `list`, `remove` actions via
    core `SuppressionStore` (`.lemma/suppressions.json`, audit semantics): JSON
    stdout with schema/status/results; `add` requires fingerprint/owner/reason/
    expiry; `remove` exits non-zero on missing suppression as structured error.
  - `lemma calibrate` runs calibration from a fixtures directory and writes JSON
    report output via core calibration APIs (`--root`, `--fixtures-dir`,
    `--output` with sensible defaults/relative resolution), emitting the report
    JSON to stdout.
  - `lemma verify-evidence` resolves run id (explicit or latest progress/evidence
    fallback), runs core `verifyEvidence`, emits JSON result including tamper
    handling fields (`confidence_cap`/`decision` on tamper as applicable), and
    exits 0 when not tampered else 1 (or 2 on missing run/evidence resolution
    error).
  - `pnpm lint`, `pnpm --filter @lemma/cli typecheck`,
    `pnpm --filter @lemma/cli build`, and
    `pnpm exec vitest run packages/cli/test/cli-commands-extended.test.ts` pass
    in this environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/cli typecheck` (pass), `pnpm --filter @lemma/cli build` (pass), `pnpm exec vitest run packages/cli/test/cli-shell.test.ts packages/cli/test/cli-commands.test.ts packages/cli/test/cli-commands-extended.test.ts` (pass, 15 tests).
- **Evidence:** `packages/cli/src/commands.ts` (LEM-085 command handlers wired into registry), `packages/cli/test/cli-commands-extended.test.ts`, `docs/parity/evidence/LEM-085-cli-extended-test-output.txt`, updated `docs/parity/assay-feature-inventory.md` (LEM-085 rows). Commands: `personas` list/lint/scaffold (core APIs, lint exit 0/1, scaffold exit 0/2), `sarif`/`junit` (latest report, file or JSON stdout including wrapped JUnit XML), `sign-report`/`verify-report` (key/signature file-or-literal, verify exit 0/1), `suppress`/`suppressions` add/list/remove (`SuppressionStore`), `calibrate` (`writeCalibrationReport`), `verify-evidence` (run-id resolution + core `verifyEvidence`, tamper hold/exit). JSON-only stdout and core exit/error mapping preserved.

### LEM-086 — Port the strict-judge agent loop (cap 7, allowlist, dedupe)

- **Epic:** E8 CLI and Agent Core
- **Priority:** P0
- **Points:** 8
- **Depends on:** LEM-083, LEM-084
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/agent/test/agent-loop.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass.
- **Description:** Port the host-neutral strict-judge agent loop core to
  `@lemma/agent` with bounded iterations (cap 7), command allowlist
  enforcement, and executed-command dedupe.
- **Acceptance Criteria:**
  - `@lemma/agent` exports strict-judge loop primitives including decision
    parsing, allowlist checking, command-to-args/signature helpers, and
    `runStrictJudgeLoop` (or equivalent) with injectable deps
    (`runHarness`, `askLlm`, optional `progress`/`sendFinal`).
  - Loop enforces a hard iteration cap of 7 total harness-execution iterations
    (including the initial run) and rejects requests above the cap.
  - Only allowlisted commands may execute (`run`, `report`, `status`, `abort`,
    `assay-browser`, `assay-demo`); disallowed commands are rejected and not
    executed.
  - Executed command signatures are deduped so the same command/args (and
    relevant env signature) is never executed twice; duplicate decisions are
    skipped/recorded without rerun.
  - Decision handling supports command/need-user-context/done/invalid parsing in
    a strict JSON form; early `done` is rejected when minimum harness runs are
    not satisfied (core behavior), and loop stops/emits final outcome on
    completion, invalid/unparseable decisions, context requests, or cap.
  - `pnpm lint`, `pnpm --filter @lemma/agent typecheck`,
    `pnpm --filter @lemma/agent build`, and
    `pnpm exec vitest run packages/agent/test/agent-loop.test.ts` pass in this
    environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/agent typecheck` (pass), `pnpm --filter @lemma/agent build` (pass), `pnpm exec vitest run packages/agent/test/agent-loop.test.ts` (pass, 5 tests).
- **Evidence:** `packages/agent/src/index.ts`, `packages/agent/test/agent-loop.test.ts`, `docs/parity/evidence/LEM-086-agent-loop-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`. Implements `runStrictJudgeLoop` with cap 7 (total steps including initial), allowlist (`run/report/status/abort/assay-browser/assay-demo`), signature-based dedupe (no reruns), strict JSON decision parsing (command/context/done/invalid), min-harness-run guard on early done, and injectable deps; interactive persistence/context protocol remain LEM-087/LEM-091.

### LEM-087 — Port agent state persistence and in-session resume

- **Epic:** E8 CLI and Agent Core
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-010, LEM-086
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/agent/test/agent-state.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass.
- **Description:** Port persisted agent-loop state and in-session resume
  behavior so bounded loop progress can be safely saved, reloaded, and resumed
  without repeating executed steps.
- **Acceptance Criteria:**
  - `@lemma/agent` provides persisted agent-state primitives: versioned
    serializable state (key/goal/session/test plan, executed command signatures,
    run summaries/current report, iteration/step counters, and optional pending
    context/request fields), deterministic state path/key derivation under
    `.lemma/agent/`, and atomic save/load helpers (using core atomic/fs
    primitives) that tolerate missing/corrupt/incompatible state safely.
  - `runStrictJudgeLoop` (or equivalent) supports persistence/resume options
    (`cwd`, `stateKey`, optional `sessionID`, `userInput`/resume input): when a
    matching saved state exists it is restored (rehydrating dedupe set and
    progress) instead of rerunning completed/executed steps; state is saved on
    pause/progress/completion/cap/context-request outcomes as applicable.
  - In-session resume can apply provided user input to a pending context/request
    state (e.g. skip or provided context text) to clear/progress the pending
    step and continue the loop without re-executing previously executed
    commands; no secrets are persisted in saved agent state.
  - `pnpm lint`, `pnpm --filter @lemma/agent typecheck`,
    `pnpm --filter @lemma/agent build`, and
    `pnpm exec vitest run packages/agent/test/agent-state.test.ts` pass in this
    environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/agent typecheck` (pass), `pnpm --filter @lemma/agent build` (pass), `pnpm exec vitest run packages/agent/test/agent-state.test.ts packages/agent/test/agent-loop.test.ts` (pass, 8 tests).
- **Evidence:** `packages/agent/src/index.ts` (versioned `PersistedAgentState`, deterministic `.lemma/agent/<hash>.json` path/key, atomic save/load with core primitives, tolerant missing/corrupt/incompatible handling, persistence/resume in `runStrictJudgeLoop` via `cwd`/`stateKey`/`sessionID`/`userInput`, pending-context resume/apply and redacted persistence), `packages/agent/test/agent-state.test.ts`, `packages/agent/test/agent-loop.test.ts` (regression), `docs/parity/evidence/LEM-087-agent-state-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`.

### LEM-088 — Port command argument builders

- **Epic:** E8 CLI and Agent Core
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-083
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/agent/test/command-args.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass.
- **Description:** Port host-neutral command argument builders/invocation logic
  (URL extraction, browser/demo/generic invocation builders, subcommand
  passthrough and safe flag handling) for use by the agent loop and adapters.
- **Acceptance Criteria:**
  - `@lemma/agent` exports command-argument builder primitives ported from
    assay semantics: `extractUrl`, `isUrl`, `SUBCOMMANDS` (CLI subcommand
    passthrough set), and `browserInvocation`, `demoInvocation`,
    `assayInvocation` (or equivalent) returning `{ args, error? }` for
    persona-dir-scoped invocations.
  - `browserInvocation` requires an explicit reachable http(s) URL (no
    directory-only/missing target) and builds a live Playwright-oriented run
    without `--no-browser`; bare URL gets comprehensive visible defaults
    (crawl, `--max-pages 8`, mobile, headed, active, active-interactions) while
    explicit user flags override defaults and only safe browser flags/tokens are
    passed through (no target/`--no-browser` injection).
  - `demoInvocation` falls back to a static inventory without a URL
    (`--target . --no-browser --intent "Assay demo assessment"`), and uses a
    URL for live browser checks with browser defaults/explicit overrides.
  - `assayInvocation` passes CLI subcommands/help/version through unchanged,
    uses an explicit URL as a browser target (no `--no-browser`), and keeps the
    static default when no URL is present.
  - `commandToArgs`/loop integration uses the ported builders for
    `assay`/`assay-browser`/`assay-demo` command forms so allowlisted loop
    behavior remains correct and existing agent loop/state tests continue to
    pass.
  - `pnpm lint`, `pnpm --filter @lemma/agent typecheck`,
    `pnpm --filter @lemma/agent build`, and
    `pnpm exec vitest run packages/agent/test/command-args.test.ts` pass in this
    environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/agent typecheck` (pass), `pnpm --filter @lemma/agent build` (pass), `pnpm exec vitest run packages/agent/test/command-args.test.ts packages/agent/test/agent-loop.test.ts packages/agent/test/agent-state.test.ts` (pass, 13 tests).
- **Evidence:** `packages/agent/src/command-args.ts`, `packages/agent/src/index.ts` (exports + `commandToArgs` integration for `assay`/`assay-browser`/`assay-demo`), `packages/agent/test/command-args.test.ts`, regression in `packages/agent/test/agent-loop.test.ts` and `packages/agent/test/agent-state.test.ts`, `docs/parity/evidence/LEM-088-command-args-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`. Ports `extractUrl`/`isUrl`/`SUBCOMMANDS` and `browserInvocation`/`demoInvocation`/`assayInvocation` with browser defaults, safe flag passthrough, URL-required browser/demo live runs, and subcommand/help/version passthrough.

### LEM-089 — Port the 59-command catalog and intent mapping

- **Epic:** E8 CLI and Agent Core
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-088
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/agent/test/catalog.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass.
- **Description:** Port the host-neutral assay slash-command catalog and
  intent/invocation mapping so adapters and agent surfaces can register and run
  the canonical command set deterministically.
- **Acceptance Criteria:**
  - `@lemma/agent` exports the canonical 59-command assay catalog (name/label
    entries matching assay order/values) and helpers to resolve catalog entries
    and intent strings (`Assay <label> assessment`).
  - Catalog intent/invocation mapping is host-neutral and deterministic:
    `assay-browser` maps to live browser invocation semantics (URL-required,
    builder-backed; no static `--no-browser` fallback), `assay-demo` maps to
    demo invocation semantics (static inventory without URL, live browser with
    URL), and all other catalog commands map to static assessment runs
    (`run --target . --no-browser --personas-dir <dir> --intent "Assay <label> assessment"`).
  - Helpers expose sufficient metadata for adapters/loop to select behavior
    (e.g. command name/label/intent, browser/demo/static kind, invocation
    builder result and/or error) without importing host SDKs or embedding host
    prompts.
  - `pnpm lint`, `pnpm --filter @lemma/agent typecheck`,
    `pnpm --filter @lemma/agent build`, and
    `pnpm exec vitest run packages/agent/test/catalog.test.ts` pass in this
    environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/agent typecheck` (pass), `pnpm --filter @lemma/agent build` (pass), `pnpm exec vitest run packages/agent/test/catalog.test.ts packages/agent/test/command-args.test.ts packages/agent/test/agent-loop.test.ts packages/agent/test/agent-state.test.ts` (pass, 17 tests).
- **Evidence:** `packages/agent/src/catalog.ts`, `packages/agent/src/index.ts` (exports catalog/intent/mapping helpers and types), `packages/agent/test/catalog.test.ts`, `docs/parity/evidence/LEM-089-catalog-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`. Exports `ASSAY_COMMAND_CATALOG` (59 entries, assay order), `getAssayCommand`, `assayIntent` (`Assay <label> assessment`), `getCatalogCommandKind`, and `buildCatalogInvocation` mapping browser→builder-backed URL-required live semantics, demo→static inventory/live-by-URL, others→deterministic static `run --target . --no-browser` with intent.

### LEM-090 — Port the browser agent prompt and invariants

- **Epic:** E8 CLI and Agent Core
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-088
- **Status:** Done
- **Claimed:** 2026-11-16 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/agent/test/browser-agent-prompt.test.ts`.
- **Completed:** 2026-11-16 — all acceptance criteria pass.
- **Description:** Port the host-neutral browser agent prompt and invariants
  (context-gathering UX contract and browser assessment instructions) for use
  by adapters/agent flows without importing host SDKs.
- **Acceptance Criteria:**
  - `@lemma/agent` exports browser prompt primitives ported from assay
    semantics: `shellQuote`, `CONTEXT_PROTOCOL`, and `buildBrowserAgentPrompt`
    (with typed input for URL/args/project directory/repo root/python and
    SSRF allowlist or equivalent fields).
  - `CONTEXT_PROTOCOL` preserves the native question-tool context gathering
    contract and invariants (sequential source/method/collect/identifier/
    confirm/record flow, Skip/Paste/MCP/Secure env-secret ref options, Jira
    native form path via `assay_jira_context` with in-memory token handling and
    no raw-secret prompting/persistence/echo, no placeholder shell waits/stdin
    blocking/prose-only context requests, and explicit blocker/gap handling when
    question tool is unavailable).
  - `buildBrowserAgentPrompt` embeds target/command/environment context and the
    browser assessment invariants (deterministic harness-owned execution/
    evidence/scoring and fixed phase order, JSON run report as source of truth,
    hashed `.harness/` evidence, no repeated commands, secrets/credential
    handling, testing-environment/scenario behavior, scope limits) and includes
    `CONTEXT_PROTOCOL` and the iteration flow.
  - `pnpm lint`, `pnpm --filter @lemma/agent typecheck`,
    `pnpm --filter @lemma/agent build`, and
    `pnpm exec vitest run packages/agent/test/browser-agent-prompt.test.ts`
    pass in this environment.
- **Verification:** `pnpm lint` (pass), `pnpm --filter @lemma/agent typecheck` (pass), `pnpm --filter @lemma/agent build` (pass), `pnpm exec vitest run packages/agent/test/browser-agent-prompt.test.ts packages/agent/test/catalog.test.ts packages/agent/test/command-args.test.ts packages/agent/test/agent-loop.test.ts packages/agent/test/agent-state.test.ts` (pass, 21 tests).
- **Evidence:** `packages/agent/src/browser-agent-prompt.ts`, `packages/agent/src/index.ts` (exports prompt primitives/types), `packages/agent/test/browser-agent-prompt.test.ts`, `docs/parity/evidence/LEM-090-browser-agent-prompt-test-output.txt`, updated `docs/parity/assay-feature-inventory.md`. Ports `shellQuote`, `CONTEXT_PROTOCOL` (native question-tool UX, Jira form/`assay_jira_context`, Skip/Paste/MCP/Secure env-secret ref, no placeholder waits/raw-secret handling, blocker/gap fallback), and `buildBrowserAgentPrompt` embedding target/command/env, browser invariants (deterministic harness-owned execution/evidence/scoring, fixed phases, JSON run report, hashed evidence, no repeats, secrets/testing-environment/scenario/scope rules), context protocol, and iteration flow.

### LEM-073 — Build report-schema compatibility and contract tests

- **Epic:** E6 Reporting, Policy, and Exports
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-020
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/report/report-contract.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; report contract tests 2/2 passed, plus `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass.
- **Description:** Expand report contract/compatibility tests covering schema
  files, validation rules, additive compatibility, and parity-critical report
  shapes (including metering/trend/policy/contract-failure invariants).
- **Acceptance Criteria:**
  - Core contract tests validate that `schemas/report/report.v1.schema.json`
    matches the report builder's published schema (`reportSchema()`/validator)
    and that `schemas/report/index.json` references the report schema file.
  - Contract tests assert `schema_version` enum includes the builder's report
    schema version, and validate built reports (normal/halted/failed/ship paths)
    against the published schema using the core validator.
  - Contract tests enforce schema rules: removing required fields or retyping
    required fields fails validation; additive optional fields and additive
    nested optional fields are allowed (compatibility).
  - Contract tests cover parity-critical shapes (decision, confidence gate,
    coverage summary fields, findings/blockers/invalid_findings ordering
    invariants in structure, metering summary fields incl. run-scoped fields,
    trend fields, policy block) and evidence/limitations additions behavior.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/report/report-contract.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/core/test/report/report-contract.test.ts`
- **Evidence:** `packages/core/test/report/report-contract.test.ts`, `docs/parity/evidence/LEM-073-report-contract-test-output.txt`, published schema/index alignment checks (`schemas/report/report.v1.schema.json`, `schemas/report/index.json`); parity inventory updated (LEM-073). Commit/remote recorded in completion summary.

### LEM-072 — Port run-scoped and sink-wide metering summaries

- **Epic:** E6 Reporting, Policy, and Exports
- **Priority:** P1
- **Points:** 2
- **Depends on:** LEM-020
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/metering/metering-summary.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; metering summary tests 3/3 passed, plus `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass.
- **Description:** Port metering summary computation that reports both sink-wide
  and run-scoped usage totals for a run (parity with assay QH-099), keeping the
  metering contract/report projection compatible.
- **Acceptance Criteria:**
  - `@lemma/core` provides a metering summary API (e.g. `summarizeMetering`/
    equivalent) that computes a deterministic summary for a given run id from
    metering events (JSONL sink/file or event records), returning at least
    `schema_version`, `sink`, `workspace`, sink-wide `event_count`/`event_types`,
    and run-scoped `run_event_count`/`run_event_types` (events whose `run`
    matches the run id).
  - Summary semantics are parity-aligned: `event_count`/`event_types` remain the
    sink-wide totals while `run_event_count`/`run_event_types` isolate the
    report run in a shared sink; duplicate events with the same `idempotency_key`
    are not double-counted; event type maps are deterministically ordered.
  - Report integration remains compatible: metering summary fields can be carried
    in report/options state (existing normalization preserved) so run and
    cumulative totals are both representable.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/metering/metering-summary.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/core/test/metering/metering-summary.test.ts`
- **Evidence:** `packages/core/src/metering.ts` (`summarizeMeteringEvents`/`summarizeMeteringSink`/`readMeteringEvents` with idempotency-key dedupe and deterministic sink-wide vs run-scoped counts), exports/index wiring, `packages/core/test/metering/metering-summary.test.ts`, `docs/parity/evidence/LEM-072-metering-summary-test-output.txt`; parity inventory updated (LEM-072). Commit/remote recorded in completion summary.

### LEM-071 — Port `verify-evidence` and the hold-on-tamper behavior

- **Epic:** E6 Reporting, Policy, and Exports
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-017
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/evidence/verify-evidence.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; verify-evidence tests 4/4 passed, plus `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass.
- **Description:** Port offline evidence manifest/artifact verification and the
  hold-on-tamper behavior (core APIs/semantics used by `verify-evidence`; CLI
  command remains LEM-085), parity-aligned with assay.
- **Acceptance Criteria:**
  - `@lemma/core` provides a verify-evidence API (e.g. `verifyEvidence` or
    equivalent) that verifies a run's evidence manifest signature and artifacts
    offline (by explicit `runId` or by resolving the target run when omitted, per
    parity behavior), returning a machine-readable result including at least
    `command` (`verify-evidence`), `run_id`, verification fields
    (`checked`/`missing`/`mismatches`/`signature_valid`/`signature_error`/
    `tampered`/`affected`/`alert`), and a clear error/not-found result when no
    run/evidence can be resolved.
  - Hold-on-tamper behavior is enforced: when verification reports tampering, the
    result sets `confidence_cap: 0.0` and `decision: "hold"` (and indicates
    failure) so tampered evidence cannot support release confidence; clean
    verification reports non-tampered/ok without fabricated hold/cap fields.
  - Verification covers parity cases: valid signed manifest+artifacts pass,
    artifact byte/hash tamper, missing artifact, and manifest/signature tamper
    are detected with affected path/check_id/reason details as applicable.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/evidence/verify-evidence.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/core/test/evidence/verify-evidence.test.ts`
- **Evidence:** `packages/core/src/evidence.ts` (`verifyEvidence` with run-id resolution and hold-on-tamper `confidence_cap`/`decision`), `packages/core/src/index.ts`, `packages/core/test/evidence/verify-evidence.test.ts`, `docs/parity/evidence/LEM-071-verify-evidence-test-output.txt`; parity inventory updated (LEM-071). Commit/remote recorded in completion summary.

### LEM-070 — Port labeled calibration fixtures and `calibrate`

- **Epic:** E6 Reporting, Policy, and Exports
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-018
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/calibration/calibration.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; calibration tests 3/3 passed, plus `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass.
- **Description:** Port labeled confidence calibration fixtures and core
  calibration APIs/report generation used by `calibrate` (parity with assay;
  CLI command remains LEM-085).
- **Acceptance Criteria:**
  - Repo includes labeled calibration fixtures under `calibration/fixtures/`
    (ported from assay semantics): at least 12 fixtures covering `ship`,
    `review`, and `hold` expected outcomes, each defining checks/findings and
    expected decision/gate metadata (including halted/status/intentional cases as
    applicable).
  - `@lemma/core` provides calibration APIs (e.g. `loadCalibrationFixtures`,
    `runCalibration`, `writeCalibrationReport` or equivalents) that score
    fixtures with the current confidence formula/policy and produce a report with
    schema `quality-harness.calibration/v1`, `formula` `weighted-coverage-v1`,
    `fixture_count`, per-fixture results (id/label/description, expected/actual
    decision and gate, match flags, intentional/human note, score/band/gate,
    gate reasons, coverage/breakdown/penalties/domain scores), and summary counts
    (expected/actual decisions, matches/mismatches, mismatched fixtures,
    intentional disagreements).
  - Actual decision derivation is parity-aligned: `hold` for halted/failed run
    status; otherwise based on confidence gate (`pass`→ship, `fail`→hold,
    `warn`→review). `writeCalibrationReport` writes formatted JSON to the output
    path (creating parent dirs) and returns the report.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/calibration/calibration.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/core/test/calibration/calibration.test.ts`
- **Evidence:** `calibration/fixtures/` (14 labeled fixtures), `packages/core/src/calibration.ts`, `packages/core/src/index.ts`, `packages/core/test/calibration/calibration.test.ts`, `docs/parity/evidence/LEM-070-calibration-test-output.txt`; parity inventory updated (LEM-070). Commit/remote recorded in completion summary.

### LEM-069 — Port baseline suppression with owner and expiry

- **Epic:** E6 Reporting, Policy, and Exports
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-013
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/suppression/suppression.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; suppression tests 4/4 passed, plus `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass.
- **Description:** Port baseline finding suppression with required owner/reason,
  future expiry, durable storage, audit events, and expired-suppression
  handling (core APIs/semantics; CLI commands remain LEM-085).
- **Acceptance Criteria:**
  - `@lemma/core` provides a suppression store/API (e.g. `SuppressionStore` or
    equivalent) persisted under `.lemma/suppressions.json` with schema/versioned
    records containing fingerprint, owner, reason, ticket (optional), expiry,
    and created timestamp.
  - `add` validates required fingerprint/owner/reason and requires a valid
    ISO-8601 expiry in the future; invalid/missing fields or non-future/invalid
    expiry are rejected. `remove` requires an existing fingerprint. `list/load`
    return stored suppressions and `active_and_expired(now?)` classifies records
    (invalid expiry treated as expired).
  - Every suppression mutation (`add`/`remove`) appends an audit event to
    `.lemma/events.jsonl` (e.g. `suppression_added`/`suppression_removed`) with
    relevant metadata; storage writes are atomic/safe.
  - Core provides suppression application semantics for findings: active
    suppressions mark matching findings as suppressed with owner/reason/ticket/
    expiry metadata (visible, not deleted), while expired suppressions stop
    applying and produce a low-severity expired-suppression finding
    (`suppression-expired:<fingerprint>`, parity-aligned fields) without
    duplicates; scoring remains unaffected by suppressed findings (existing
    behavior preserved).
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/suppression/suppression.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/core/test/suppression/suppression.test.ts`
- **Evidence:** `packages/core/src/suppressions.ts`, `packages/core/src/index.ts`, `packages/core/test/suppression/suppression.test.ts`, `docs/parity/evidence/LEM-069-suppression-test-output.txt`; parity inventory updated (LEM-069). Commit/remote recorded in completion summary.

### LEM-068 — Port run-to-run trend diff

- **Epic:** E6 Reporting, Policy, and Exports
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-011, LEM-020
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/trends/trend.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; trend diff tests 3/3 passed, plus `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass.
- **Description:** Port run-to-run trend diff computation comparing a run's
  finding fingerprints and score against the previous history entry for the same
  target (parity with assay trend semantics).
- **Acceptance Criteria:**
  - `@lemma/core` provides a trend diff API (e.g. `computeTrendDiff`/equivalent)
    that returns a report-compatible trend object: `baseline`, `previous_run_id`,
    `new`, `resolved`, `persistent` (fingerprint lists), `score_delta`, and
    `coverage_delta`.
  - When no prior comparable run exists for the same target (excluding the
    current run), result is a baseline with no fabricated deltas (`baseline:
    true`, null previous id, empty lists, zero deltas). When a previous run
    exists, it selects the most recent matching history entry for the same
    target and computes `new`/`resolved`/`persistent` as sorted fingerprint set
    differences/intersections.
  - `score_delta` is computed as current score minus previous score (rounded to
    one decimal place, parity behavior), and `coverage_delta` remains explicit
    `0.0` when coverage history is unavailable (no fabricated value).
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/trends/trend.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/core/test/trends/trend.test.ts`
- **Evidence:** `packages/core/src/trends.ts`, `packages/core/src/index.ts`, `packages/core/test/trends/trend.test.ts`, `docs/parity/evidence/LEM-068-trend-diff-test-output.txt`; parity inventory updated (LEM-068). Commit/remote recorded in completion summary.

### LEM-067 — Port report signing and verification

- **Epic:** E6 Reporting, Policy, and Exports
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-020
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/exports/report-signing.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; report signing tests 3/3 passed, plus `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass.
- **Description:** Port deterministic report signing and verification APIs for
  `quality-harness.report/v1` reports (HMAC-SHA256 detached signature parity).
- **Acceptance Criteria:**
  - `@lemma/core` provides report signing/verification APIs (e.g. in exports
    module/subpath) including canonical report serialization/bytes and
    `signReport`/`verifyReportSignature` (or parity-equivalent names) using
    HMAC-SHA256 over canonicalized report JSON.
  - A valid signature verifies for the same report+key; verification fails for a
    wrong/tampered signature and fails after report content changes (tamper
    detection), using constant-time comparison semantics.
  - APIs accept key input in practical forms supported by implementation (e.g.
    string/bytes-like) and behave deterministically for identical inputs.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/exports/report-signing.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/core/test/exports/report-signing.test.ts`
- **Evidence:** `packages/core/src/exports.ts` (`canonicalReportString`/`canonicalReportBytes`, `signReport`, `verifyReportSignature`), `packages/core/test/exports/report-signing.test.ts`, `docs/parity/evidence/LEM-067-report-signing-test-output.txt`; parity inventory updated (LEM-067). Commit/remote recorded in completion summary.

### LEM-066 — Port JUnit export

- **Epic:** E6 Reporting, Policy, and Exports
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-020
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/exports/junit.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; JUnit export tests 2/2 passed, plus `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass.
- **Description:** Port JUnit XML report export for `quality-harness.report/v1`
  checks to `@lemma/core/exports` with redaction and parity-aligned mapping.
- **Acceptance Criteria:**
  - `@lemma/core` provides a JUnit export API (e.g. `buildJunit(report)` in
    exports module/subpath) that converts a lemma report into a JUnit XML
    document/string with a `testsuite` named `quality-harness`, correct
    `tests`/`failures`/`errors`/`skipped` counts, and one `testcase` per check.
  - Each check maps to a testcase with stable identity/metadata (`name` = check
    id, `classname` = domain, `status` preserved). Status mapping is
    parity-aligned: `failed` emits `<failure>` with check `actual`, `error`
    emits `<error>` with check `actual`, `blocked` and `skipped` emit
    `<skipped>` with appropriate message text (blocked prefixed as in assay),
    and passing/planned checks emit no failure/error/skipped child.
  - Export output is redacted (no secret/token/credential values leaked); secret
    values present in check/report fields are replaced with redaction markers.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/exports/junit.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/core/test/exports/junit.test.ts`
- **Evidence:** `packages/core/src/exports.ts` (`buildJunit`), `packages/core/test/exports/junit.test.ts`, `docs/parity/evidence/LEM-066-junit-export-test-output.txt`; parity inventory updated (LEM-066). Commit/remote recorded in completion summary.

### LEM-065 — Port SARIF export

- **Epic:** E6 Reporting, Policy, and Exports
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-020
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/core/test/exports/sarif.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; SARIF export tests 3/3 passed, plus `pnpm --filter @lemma/core typecheck/build` and `pnpm lint` pass.
- **Description:** Port SARIF 2.1.0 report export for `quality-harness.report/v1`
  findings to `@lemma/core/exports` with redaction and parity-aligned mapping.
- **Acceptance Criteria:**
  - `@lemma/core` provides a SARIF 2.1.0 export API (e.g. `buildSarif(report)` in
    exports module/subpath) that converts a lemma report into a SARIF document
    with `$schema`/`version`, a single run, tool driver name `quality-harness`,
    and `rules`/`results` derived from report findings.
  - Each finding maps to a stable rule/result: rule id/name derived from check/finding
    identity, severity mapped to SARIF levels (`critical|high -> error`,
    `medium -> warning`, others -> `note`), rule/result descriptions/help include
    finding title/consequence/remediation as applicable, result locations use
    finding location, and finding evidence paths are represented as related
    locations when present. Useful properties (severity/domain/tags/fingerprint/
    persona/strength/check identity) are preserved.
  - Export output is redacted (no secret/token/credential values leaked); secret
    values present in finding/report fields are replaced with redaction markers.
  - `pnpm lint`, `pnpm --filter @lemma/core typecheck`,
    `pnpm --filter @lemma/core build`, and
    `pnpm exec vitest run packages/core/test/exports/sarif.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/core/test/exports/sarif.test.ts`
- **Evidence:** `packages/core/src/exports.ts`, `packages/core/src/index.ts`, `packages/core/package.json` (`./exports` subpath/build wiring), `packages/core/test/exports/sarif.test.ts`, `docs/parity/evidence/LEM-065-sarif-export-test-output.txt`; parity inventory updated (LEM-065). Commit/remote recorded in completion summary.

### LEM-064 — Build the browser regression suite

- **Epic:** E5 Browser and Operate Layer
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-051, LEM-054, LEM-055, LEM-058
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-regression-suite.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; browser regression suite 7/7 passed, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Build a deterministic browser regression suite covering the key
  browser behaviors ported in LEM-051/054/055/058 to prevent regressions.
- **Acceptance Criteria:**
  - Add a browser regression suite test file
    `packages/browser/test/browser-regression-suite.test.ts` that runs as a
    single vitest suite and exercises regression coverage across:
    - **LEM-051 core checks:** representative `browser.load`, `browser.console`,
      `browser.network`, `browser.content`, and `browser.links` outcomes
      (pass/fail/blocking-relevant behavior and evidence/metadata linkage as
      applicable) using deterministic/injected page views.
    - **LEM-054 crawl:** bounded multi-route evaluation/merge behavior
      (crawled/page_count/routes metadata, per-route handling/aggregation, and
      deterministic route discovery expectations as applicable).
    - **LEM-055 mobile pack:** `browser.overflow` and `browser.focus_order`
      evaluator/runtime behavior (pass and failure cases with expected
      viewport/overflow/focus metadata contracts preserved).
    - **LEM-058 scenarios/steps:** `browser.steps` deterministic regression via
      injected scenario execution/plan handling (success and failure/blocking
      outcome cases as applicable) without requiring external network.
  - The regression suite is deterministic and environment-safe (no live network,
    no required real browser/Chromium), relying on injected observations,
    scenario execution inputs, or test doubles as needed.
  - `pnpm lint`, `pnpm --filter @lemma/browser typecheck`,
    `pnpm --filter @lemma/browser build`, and
    `pnpm exec vitest run packages/browser/test/browser-regression-suite.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-regression-suite.test.ts`
- **Evidence:** `packages/browser/test/browser-regression-suite.test.ts`, `docs/parity/evidence/LEM-064-browser-regression-suite-test-output.txt`; parity inventory `harness/browser.py` row updated (LEM-064). Commit/remote recorded in completion summary.

### LEM-063 — Port browser defaults (crawl, mobile, headed, active)

- **Epic:** E5 Browser and Operate Layer
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-054, LEM-055
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-defaults.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; browser defaults tests 5/5 passed, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass (targeted crawl/runtime/viewport regressions passed).
- **Description:** Port browser runtime option defaults/contracts for crawl, mobile,
  headed, and active behavior to align with assay parity.
- **Acceptance Criteria:**
  - **Crawl defaults:** `crawl` defaults to `false`. When `options.crawl` is
    enabled and no explicit `maxPages`/`max_pages` is provided, the effective
    max-pages default is `5` (assay parity). Explicit `maxPages`/`max_pages`
    override the default. Existing bounded same-origin crawl behavior remains
    intact.
  - **Mobile defaults:** `@lemma/browser` runtime options accept mobile-mode
    defaults (`mobile` and/or compatible aliases/viewport option such as
    `mobileViewport`). When mobile mode is enabled and no explicit `viewport`
    is provided, the effective viewport defaults to `390x844` and is applied to
    Playwright capture context and recorded as `metadata.viewport` on produced
    outcomes. An explicit `viewport` overrides the mobile default.
  - **Headed defaults:** Browser runs are headless by default. Runtime options
    accept `headed` (show browser) in addition to `headless`, with deterministic
    precedence consistent with assay intent (explicit `headless: true` forces
    headless; otherwise `headed: true` requests a visible browser; default is
    headless).
  - **Active defaults:** Runtime options accept active-probe defaults/contracts
    (`active` defaults to `false`, `activeInteractions`/`active_interactions`
    defaults to `true`) and expose/normalize them without breaking existing
    browser execution paths (active probes may remain unimplemented in this
    slice, but option defaults/contracts are present and non-regressive).
  - `pnpm lint`, `pnpm --filter @lemma/browser typecheck`,
    `pnpm --filter @lemma/browser build`, and
    `pnpm exec vitest run packages/browser/test/browser-defaults.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-defaults.test.ts`
- **Evidence:** `packages/browser/src/runtime.ts`, `packages/browser/test/browser-defaults.test.ts`, `docs/parity/evidence/LEM-063-browser-defaults-test-output.txt`; parity inventory `harness/browser.py` row updated (LEM-063). Commit/remote recorded in completion summary.

### LEM-062 — Port viewport and check metadata contracts

- **Epic:** E5 Browser and Operate Layer
- **Priority:** P2
- **Points:** 2
- **Depends on:** LEM-051, LEM-055
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-viewport-metadata.test.ts`. (Taken out of priority/lowest-unblocked order vs higher-priority unblocked `LEM-063`/`LEM-064` at explicit user request.)
- **Completed:** 2026-11-15 — all acceptance criteria pass; viewport/check metadata tests 4/4 passed, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass (targeted existing browser regressions also passed).
- **Description:** Port browser viewport and check metadata contracts so browser
  check outcomes carry consistent, parity-aligned viewport/route metadata.
- **Acceptance Criteria:**
  - Browser runtime accepts an explicit viewport contract in options (e.g.
    `viewport` as `"WxH"` and/or `{ width, height }`, and/or `viewportWidth`/
    `viewportHeight`) and uses it for Playwright capture context; when not
    specified, behavior remains deterministic and outcomes still record a viewport
    metadata value.
  - Every evaluated browser check outcome produced by `@lemma/browser` includes
    `metadata.viewport` as a `"WxH"` string reflecting the viewport used for that
    check (including `browser.load`, content/console/network/links/security/
    accessibility/overflow/focus_order and scenario `browser.steps` outcomes as
    applicable). Injected/page-view evaluation paths also honor/provide viewport
    metadata consistently.
  - Crawl/merged browser outcomes preserve check metadata contracts: merged
    outcomes include `metadata.viewport` and retain existing crawl metadata
    (`crawled`, `page_count`, `routes`, `routes_not_evaluated` when present);
    per-route metadata remains consistent with route/page labeling.
  - `browser.overflow` and `browser.focus_order` remain contract-compatible
    (including existing viewport/overflow/focus metadata such as
    `viewport_width`, `scroll_width`, `offending_element`,
    `positive_tabindex_count`) alongside the `metadata.viewport` string.
  - `pnpm lint`, `pnpm --filter @lemma/browser typecheck`,
    `pnpm --filter @lemma/browser build`, and
    `pnpm exec vitest run packages/browser/test/browser-viewport-metadata.test.ts`
    pass in this environment.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-viewport-metadata.test.ts`
- **Evidence:** `packages/browser/src/runtime.ts`, `packages/browser/src/checks.ts`, `packages/browser/test/browser-viewport-metadata.test.ts`, `docs/parity/evidence/LEM-062-browser-viewport-metadata-test-output.txt`; parity inventory `harness/browser.py` row updated (LEM-062). Commit/remote recorded in completion summary.

### LEM-061 — Verify browser evidence, manifest, and report linkage

- **Epic:** E5 Browser and Operate Layer
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-016, LEM-051
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-evidence-linkage.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; linkage integration test 1/1 passed (Playwright+Chromium smoke path executed in this environment), plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Verify that browser check execution produces evidence artifacts
  that are correctly recorded in the evidence manifest and linked through check
  outcomes/state into the final report.
- **Acceptance Criteria:**
  - A runnable, skippable integration test at
    `packages/browser/test/browser-evidence-linkage.test.ts` exercises browser
    checks with a real core `EvidenceStore` against the local
    `examples/demo-web/` fixture (served on localhost; no public internet). The
    test must skip (not fail) when Playwright/Chromium is unavailable.
  - When executed, browser runtime captures and persists browser artifacts via the
    evidence store such that the finalized evidence manifest contains entries for
    captured browser evidence (e.g. screenshot and console/network/snapshot or
    navigation logs as applicable) with portable `.lemma/evidence/<run_id>/...`
    paths, hashes/bytes/metadata, and a verifiable manifest.
  - Browser check outcomes carry evidence references for produced artifacts, and
    applying outcomes to run-state checks preserves those `check.evidence`
    references for browser checks (including `browser.load`).
  - Report linkage: `buildReport(...)` includes the browser checks' `evidence`
    refs and `evidence.directory` / `evidence.summary` consistent with the
    evidence store summary/manifest location for the run; every referenced browser
    evidence path present in check/report linkage resolves to a manifest entry.
  - `EvidenceStore.verify()` reports no missing/mismatched/tampered artifacts for
    the linked browser evidence in the test run.
  - `pnpm lint`, `pnpm --filter @lemma/browser typecheck`,
    `pnpm --filter @lemma/browser build`, and
    `pnpm exec vitest run packages/browser/test/browser-evidence-linkage.test.ts`
    pass in this environment (test may be skipped if Playwright/Chromium is
    unavailable, but must not fail).
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-evidence-linkage.test.ts`
- **Evidence:** `packages/browser/test/browser-evidence-linkage.test.ts`, `docs/parity/evidence/LEM-061-browser-evidence-linkage-test-output.txt`; parity inventory `harness/browser.py` row updated with LEM-061 linkage verification. Commit/remote recorded in completion summary.

### LEM-060 — Port browser fixtures and the CI smoke/blocked legs

- **Epic:** E5 Browser and Operate Layer
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-050, LEM-051
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-smoke-leg.test.ts packages/browser/test/browser-blocked-leg.test.ts`. (Taken out of lowest-numbered/P0-priority order vs unblocked P0 `LEM-061` at explicit user request.)
- **Completed:** 2026-11-15 — all acceptance criteria pass; smoke/blocked leg tests 3/3 passed (smoke executed with local Playwright+Chromium in this environment), plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Port the clean browser fixture and the browser smoke/blocked
  CI legs so browser-enabled and blocked-degradation behavior can be exercised
  deterministically and wired into CI in a later task.
- **Acceptance Criteria:**
  - Clean browser fixture is available at `examples/demo-web/` (assay-parity
    demo fixture for local browser smoke; no public internet dependency).
  - Browser smoke leg is implemented as a runnable, skippable test at
    `packages/browser/test/browser-smoke-leg.test.ts` (or equivalent) that, when
    Playwright and a launchable Chromium are available, serves `examples/demo-web`
    on localhost, runs lemma browser checks against it (including `browser.load`)
    with SSRF-safe local allowlisting, and asserts a completed/non-blocked
    `browser.load` outcome plus captured browser evidence artifacts (e.g.
    screenshot and console/network evidence refs/log artifacts as applicable).
    The test must skip (not fail) when Playwright/Chromium is unavailable and
    must never reach the public internet.
  - Browser blocked-degradation leg is implemented as a runnable test at
    `packages/browser/test/browser-blocked-leg.test.ts` (or equivalent) that
    executes browser checks with browser runtime unavailable/disabled and asserts
    blocked outcomes (no false pass, actionable boundary/blocker metadata as
    applicable) without requiring Playwright/Chromium.
  - Parity inventory updated for LEM-060 scope: `examples/demo-web/` fixture and
    browser smoke/capture/crawl test mapping rows note the smoke/blocked legs and
    fixture parity evidence.
  - `pnpm lint`, `pnpm --filter @lemma/browser typecheck`,
    `pnpm --filter @lemma/browser build`, and
    `pnpm exec vitest run packages/browser/test/browser-smoke-leg.test.ts packages/browser/test/browser-blocked-leg.test.ts`
    pass in this environment (smoke leg may be skipped if Playwright/Chromium is
    unavailable, but must not fail).
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-smoke-leg.test.ts packages/browser/test/browser-blocked-leg.test.ts`
- **Evidence:** `examples/demo-web/` (assay-parity clean browser fixture), `packages/browser/test/browser-smoke-leg.test.ts`, `packages/browser/test/browser-blocked-leg.test.ts`, `docs/parity/evidence/LEM-060-browser-legs-test-output.txt`; parity inventory `examples/demo-web/` and browser smoke/capture/crawl test mapping rows updated (LEM-060). Commit/remote recorded in completion summary.

### LEM-059 — Port SSRF-safe target validation and allowlists

- **Epic:** E5 Browser and Operate Layer
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-010
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- packages/core/test/ssrf/ssrf.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; SSRF test suite 8/8 passed, plus `pnpm --filter @lemma/core typecheck` and `pnpm lint` pass.
- **Description:** Port SSRF-safe URL target validation and allowlist handling
  from assay into `@lemma/core` so targets are checked before navigation/use,
  private/link-local/loopback/metadata destinations are blocked by default, and
  explicit allowlists can safely opt in specific hosts/CIDRs.
- **Acceptance Criteria:**
  - Core SSRF module added at `packages/core/src/ssrf.ts` and exported from
    `@lemma/core` (and `@lemma/core/ssrf` subpath as needed): `validateUrl`
    (compat `validateTargetUrl`), `validateRedirectChain`, `isSafeUrl` (compat
    `ssrfSafe`), and `loadAllowlist` with injectable DNS resolver support.
  - `validateUrl` requires `http`/`https` and a host; blocks known metadata/local
    hostnames by default (`metadata.google.internal`, `metadata`,
    `kubernetes.default.svc`) unless explicitly allowlisted by name; resolves
    hostnames (or accepts IP literals) and rejects blocked/unsafe addresses
    (loopback, link-local, private, multicast, reserved, unspecified, and cloud
    metadata `169.254.169.254`) unless covered by an explicit allowlist
    CIDR/entry; named-host allowlist still requires resolution and cannot permit
    metadata address `169.254.169.254`.
  - Allowlist parsing/loading: entries may be hostnames or CIDR strings (invalid
    CIDR is a typed/config error). `loadAllowlist` reads `QH_SSRF_ALLOWLIST`
    (comma-separated), optional `QH_SSRF_ALLOWLIST_FILE`, and when `root` is
    provided `.harness/ssrf-allowlist.json` and/or `ssrf-allowlist.json`
    (supporting `{allow|allowlist}` array/string forms), with unreadable/invalid
    config surfaced as an error.
  - DNS resolution is checked per validation call (supports rebinding detection
    when resolver results change) and redirect chains are revalidated at every
    hop via `validateRedirectChain`. Resolution failures produce a typed target
    error; validation errors do not leak resolved internal IP addresses.
  - Tests at `packages/core/test/ssrf/ssrf.test.ts` cover: private/localhost/
    metadata rejection (including no leaked internal addresses in messages),
    public target allowed via injected resolver, localhost allowed only with
    config/env allowlist, CIDR allowlist override, DNS rebinding checked per
    call, redirect-chain revalidation, and allowlist loading from environment.
    Parity inventory updated for `harness/ssrf.py` (LEM-059 slice/evidence).
  - `pnpm --filter @lemma/core typecheck`, `pnpm lint`, and
    `pnpm --filter @lemma/core test -- packages/core/test/ssrf/ssrf.test.ts` pass.
- **Verification:** `pnpm --filter @lemma/core test -- packages/core/test/ssrf/ssrf.test.ts`
- **Evidence:** `packages/core/src/ssrf.ts`, `packages/core/src/ssrf-export.ts`, `packages/core/src/index.ts`, `packages/core/package.json`, `packages/core/test/ssrf/ssrf.test.ts`, `docs/parity/evidence/LEM-059-ssrf-test-output.txt`; parity inventory `harness/ssrf.py` updated (LEM-059 slice/evidence). Commit/remote recorded in completion summary.

### LEM-058 — Port scenario-file execution and `browser.steps`

- **Epic:** E5 Browser and Operate Layer
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-051
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-scenarios.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm exec vitest run packages/browser/test/browser-scenarios.test.ts` 5/5 and full browser suite 48/48, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Port scenario-file/plan execution and the `browser.steps` check
  into `@lemma/browser`, building on `@lemma/core/steps` planning/evaluation
  contracts so ticket-driven browser scenarios can be loaded, executed against
  Playwright, and reported deterministically.
- **Acceptance Criteria:**
  - Scenario loading/compilation helpers (exported) accept: (1) a JSON scenario
    plan object/file content with `title`/`steps` (and optional `source`,
    `target_url`/`targetUrl`) producing an explicit `ScenarioPlan`, and (2)
    natural-language/text instructions compiled into a `ScenarioPlan` via
    `HeuristicStepPlanner` (from `@lemma/core/steps`) with provided base/target
    URL. File-path inputs (`scenarioFile`/`scenario_file` or equivalent helper)
    are read and resolved without persisting secrets.
  - Browser scenario execution (`executeScenarioPlan`/equivalent, exported and
    Playwright-injectable/mockable) runs plan steps against a Playwright
    page/context and returns a `ScenarioExecutionResult` (core steps contract):
    supports core actions `goto`, `click`, `fill`, `select`, `assert_text`,
    `assert_visible`, `assert_no_errors`, `wait`, and `screenshot` with per-step
    pass/fail results, timing, redacted errors, and best-effort evidence refs
    (including failure screenshots when possible). Execution continues after a
    failed step to gather evidence; overall pass requires all steps passed.
  - `browser.steps` is implemented/integrated: when a scenario plan and
    executable browser context/page are available (or an injected execution
    result is provided for deterministic evaluation), the runtime/check evaluates
    `browser.steps` using `evaluateScenarioCheck` (core) producing
    passed/failed/blocked outcomes with scenario metadata and evidence refs.
    `IMPLEMENTED_BROWSER_CHECKS` includes `browser.steps` and it is no longer
    degraded as "not implemented in this slice" when runnable.
  - `runBrowserChecks`/runtime options accept scenario inputs (`scenarioPlan`,
    `scenarioFile`/`scenario_file`, and/or precomputed `scenarioExecution`/
    result injection for tests). When browser runtime/capture is unavailable or
    no runnable scenario context exists, `browser.steps` degrades/blocks with an
    actionable boundary (no crash, no false pass).
  - Tests at `packages/browser/test/browser-scenarios.test.ts` cover plan
    loading/compilation (JSON + heuristic text), step execution behavior with a
    mocked Playwright page/context/evidence (including failure continuation and
    result fields), and `browser.steps` outcome evaluation/integration
    (pass/fail/blocked). Existing browser tests continue to pass. Evidence
    recorded at `docs/parity/evidence/LEM-058-browser-steps-test-output.txt`.
  - Parity inventory updated for LEM-058 scope: `harness/browser.py`,
    `harness/step_runner.py`/scenario rows, and browser check/test mappings note
    scenario-file execution and `browser.steps` slice with evidence.
  - `pnpm --filter @lemma/browser typecheck`, `pnpm --filter @lemma/browser build`,
    `pnpm lint`, and `pnpm exec vitest run packages/browser/test/browser-scenarios.test.ts` pass.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-scenarios.test.ts`
- **Evidence:** `packages/browser/src/scenarios.ts`, `packages/browser/src/runtime.ts`, `packages/browser/src/checks.ts`, `packages/browser/src/index.ts`, `packages/browser/test/browser-scenarios.test.ts`, `packages/browser/test/browser-checks.test.ts`, `packages/browser/test/browser-crawl.test.ts`, `docs/parity/evidence/LEM-058-browser-steps-test-output.txt`; parity inventory `harness/browser.py` and `harness/step_runner.py` updated (LEM-058 scenario-file execution and `browser.steps` slice). Commit/remote recorded in completion summary.

### LEM-057 — Port HAR, trace, and video capture with redaction


- **Epic:** E5 Browser and Operate Layer
- **Priority:** P2
- **Points:** 5
- **Depends on:** LEM-051
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-capture-artifacts.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm exec vitest run packages/browser/test/browser-capture-artifacts.test.ts` 4/4 and full browser suite 43/43, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Port optional browser HAR, trace, and video capture with
  redaction from assay into `@lemma/browser` runtime capture so diagnostic
  artifacts can be recorded without leaking secrets.
- **Acceptance Criteria:**
  - `BrowserRuntimeOptions` accept capture flags `captureHar`/`capture_har`,
    `captureTrace`/`capture_trace`, and `captureVideo`/`capture_video` (disabled
    by default). When Playwright capture runs with flags enabled, runtime
    configures recording appropriately (HAR recording path/mode, tracing start
    with screenshots/snapshots/sources, and video recording directory/size when
    supported) and finalizes artifacts before context close.
  - HAR capture is saved as redacted JSON evidence (kind `har`, evidence ref
    `har`) when an evidence store is available. Redaction sanitizes request/entry
    URLs, redacts sensitive headers (`authorization`, `cookie`, `set-cookie`,
    `proxy-authorization`, `x-api-key`), cookie values, and sensitive query
    params (`token`, `access_token`, `id_token`, `api_key`, `apikey`, `secret`,
    `password`, `passwd`, `session`, `sessionid`, `jwt`, `auth`, `code`), and
    applies text redaction to string values.
  - Trace capture is saved as redacted bytes evidence (kind `trace`, evidence ref
    `trace`, `.zip` suffix/name convention compatible with Playwright traces)
    when available/requested. Text entries inside the trace archive are redacted
    for credential/token/header-like secrets before persistence; binary entries
    are preserved.
  - Video capture is saved as bytes evidence (kind `video`, evidence ref `video`,
    suffix from captured video path, default `.webm`) when Playwright provides a
    video artifact; capture is best-effort and must not crash the run if an
    artifact is unavailable. Temporary capture files/directories are cleaned up.
  - `BrowserEvidenceStoreLike`/runtime capture support byte-saving when needed
    (e.g. optional `saveBytes`) while remaining backward-compatible. Captured
    artifact refs are attached to page view `evidenceRefs` so check outcomes can
    include them via common evidence; injected `pageView`/`pageViews` bypass
    capture as before.
  - Tests at `packages/browser/test/browser-capture-artifacts.test.ts` cover
    HAR/trace/video redaction helpers and runtime capture/finalization behavior
    (via mocked Playwright/context/page/video/tracing and evidence hooks), verify
    refs/kinds and that sensitive values are redacted/not persisted in saved
    artifacts, and confirm captures are disabled by default/no crash on missing
    artifacts. Existing browser tests continue to pass. Evidence recorded at
    `docs/parity/evidence/LEM-057-browser-capture-test-output.txt`.
  - Parity inventory updated for LEM-057 scope: `harness/browser.py` row and
    browser capture/smoke-crawl test mapping note HAR/trace/video capture with
    redaction and evidence.
  - `pnpm --filter @lemma/browser typecheck`, `pnpm --filter @lemma/browser build`,
    `pnpm lint`, and `pnpm exec vitest run packages/browser/test/browser-capture-artifacts.test.ts` pass.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-capture-artifacts.test.ts`
- **Evidence:** `packages/browser/src/capture.ts`, `packages/browser/src/runtime.ts`, `packages/browser/src/checks.ts`, `packages/browser/src/index.ts`, `packages/browser/test/browser-capture-artifacts.test.ts`, `docs/parity/evidence/LEM-057-browser-capture-test-output.txt`; parity inventory `harness/browser.py` and browser capture/smoke-crawl test mapping updated (LEM-057 HAR/trace/video capture with redaction slice). Commit/remote recorded in completion summary.

### LEM-056 — Port authenticated storage-state injection


- **Epic:** E5 Browser and Operate Layer
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-050
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-storage-state.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm exec vitest run packages/browser/test/browser-storage-state.test.ts` 6/6 and full browser suite 39/39, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Port authenticated browser storage-state injection from assay
  into `@lemma/browser` so Playwright capture can run with a pre-authenticated
  session while preserving blocked degradation and secret-handling guarantees.
- **Acceptance Criteria:**
  - `BrowserRuntimeOptions` (and runtime capture) accept storage state via
    `storageState` and/or `storage_state` as a path, `env:VAR` reference, or
    already-resolved state object. An exported resolver/loader (e.g.
    `resolveBrowserStorageState`/`loadBrowserStorageState`) implements
    assay-compatible semantics: `env:VAR` missing -> unavailable with
    "Storage state environment variable '<VAR>' is not set."; file path missing
    -> unavailable with "Storage state file was not found: <value>"; invalid JSON
    -> "Storage state is not valid JSON."; non-object -> "Storage state must be a
    JSON object."; cookies/origins not arrays or invalid cookie entry -> matching
    validation errors; cookies present with no valid/unexpired cookie and no
    origins -> "Storage state has expired; provide a fresh state file or secret.";
    empty cookies and origins -> "Storage state is empty."; otherwise returns the
    parsed/resolved state for Playwright context injection.
  - When storage state is provided for Playwright capture, `runBrowserChecks`
    injects the resolved state into the browser context (`storageState`/equivalent)
    so authenticated navigation/capture can proceed. The resolved/raw storage
    state (including cookie/session values) is never persisted in browser
    outcomes, metadata, or evidence refs produced by the runtime.
  - If storage-state resolution/loading fails, browser capture becomes unavailable
    and `runBrowserChecks` degrades all requested browser checks to blocked
    outcomes with actionable blocker boundaries derived from the storage-state
    error (e.g. missing file / expired state) and does not crash. Injected
    `pageView`/`pageViews` evaluation paths remain deterministic and unaffected
    by storage-state resolution.
  - Tests at `packages/browser/test/browser-storage-state.test.ts` cover:
    resolution from file and `env:VAR`, missing env/file, invalid JSON/object,
    expired/empty state, successful Playwright capture injection of resolved
    storage state (via loader/launch hooks), and blocked degradation on missing
    storage state; secrets from resolved state are not present in emitted
    outcomes/metadata. Existing browser tests continue to pass. Evidence recorded
    at `docs/parity/evidence/LEM-056-browser-storage-state-test-output.txt`.
  - Parity inventory updated for LEM-056 scope: `harness/browser.py` row and
    `test_authenticated_browser.py` mapping note storage-state injection/
    resolution slice and evidence.
  - `pnpm --filter @lemma/browser typecheck`, `pnpm --filter @lemma/browser build`,
    `pnpm lint`, and `pnpm exec vitest run packages/browser/test/browser-storage-state.test.ts` pass.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-storage-state.test.ts`
- **Evidence:** `packages/browser/src/runtime.ts`, `packages/browser/test/browser-storage-state.test.ts`, `docs/parity/evidence/LEM-056-browser-storage-state-test-output.txt`; parity inventory `harness/browser.py` and `test_authenticated_browser.py` updated (LEM-056 storage-state injection/resolution slice). Commit/remote recorded in completion summary.

### LEM-055 — Port the responsive/mobile pack (overflow, focus order)


- **Epic:** E5 Browser and Operate Layer
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-051
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-mobile-pack.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm exec vitest run packages/browser/test/browser-mobile-pack.test.ts` 6/6 and full browser suite 33/33, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Port the responsive/mobile browser checks (`browser.overflow`,
  `browser.focus_order`) from assay into `@lemma/browser` as observation-based
  evaluators integrated with the browser runtime. Evaluators must be ready for
  mobile-pack use (viewport-aware observations/metadata) while CLI/mobile-mode
  orchestration remains owned by later catalog/orchestrator tasks.
- **Acceptance Criteria:**
  - `@lemma/browser` implements assay-parity evaluator for `browser.overflow`
    over captured observations: reads viewport width (from `snapshot.viewportWidth`
    or `snapshot.viewport_width`, defaulting to 390 when not provided) and
    `snapshot.documentScrollWidth`/`snapshot.overflowingElements`. If
    `scrollWidth > viewportWidth + 1` or any overflowing element exists, emits
    a failed medium accessibility finding (responsive/overflow/mobile tags,
    offender location/selector) with `metadata.offending_element`,
    `metadata.viewport_width`, and `metadata.scroll_width` and actual
    `Horizontal overflow: scroll width {sw} > viewport {vw}; offending element {sel}.`;
    otherwise passes with `metadata.viewport_width`/`metadata.scroll_width` and
    `No horizontal overflow: scroll width {sw} <= viewport {vw}.`
  - `@lemma/browser` implements assay-parity evaluator for `browser.focus_order`
    over captured observations: uses `snapshot.positiveTabindex` and
    `snapshot.focusOrderMatchesDom` (default true). If positive tabindex > 0 or
    focus order does not match DOM, emits a failed medium accessibility finding
    (a11y/focus/keyboard tags, final URL location) with actual
    `{n} positive tabindex value(s) disturbed focus order.`; otherwise passes
    with `Focus order follows document order.` Outcome sets
    `metadata.positive_tabindex_count`.
  - `IMPLEMENTED_BROWSER_CHECKS`/runtime integration include `browser.overflow`
    and `browser.focus_order` (no longer degraded as "not implemented in this
    slice" when runtime/observations are available), exported/testable without
    Playwright, and respect navigation-failure blocking for non-load checks.
  - Tests at `packages/browser/test/browser-mobile-pack.test.ts` cover:
    overflow pass/fail cases with offender/viewport metadata and focus-order
    pass/fail (positive tabindex and focusOrderMatchesDom false) plus runtime
    integration from injected observations. Existing browser tests continue to
    pass. Evidence recorded at
    `docs/parity/evidence/LEM-055-browser-mobile-pack-test-output.txt`.
  - Parity inventory updated for LEM-055 scope: `harness/browser.py` row and
    `test_mobile_browser.py` mapping note responsive/mobile evaluator slice and
    evidence.
  - `pnpm --filter @lemma/browser typecheck`, `pnpm --filter @lemma/browser build`,
    `pnpm lint`, and `pnpm exec vitest run packages/browser/test/browser-mobile-pack.test.ts` pass.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-mobile-pack.test.ts`
- **Evidence:** `packages/browser/src/checks.ts`, `packages/browser/test/browser-mobile-pack.test.ts`, `packages/browser/test/browser-checks.test.ts`, `packages/browser/test/browser-crawl.test.ts` (unsupported-check regressions updated to target still-unimplemented checks), `docs/parity/evidence/LEM-055-browser-mobile-pack-test-output.txt`; parity inventory `harness/browser.py` and `test_mobile_browser.py` updated (LEM-055 responsive/mobile evaluator slice). Commit/remote recorded in completion summary.

### LEM-054 — Port the bounded same-origin crawl


- **Epic:** E5 Browser and Operate Layer
- **Priority:** P1
- **Points:** 8
- **Depends on:** LEM-051
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-crawl.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm exec vitest run packages/browser/test/browser-crawl.test.ts` 5/5 and full browser suite 27/27, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Port assay's bounded same-origin crawl from `harness/browser.py`
  into `@lemma/browser`: discover safe follow-up routes from the seed page,
  navigate/capture a bounded set of same-origin pages, and evaluate browser
  checks across crawled routes with merged per-route outcomes/metadata.
- **Acceptance Criteria:**
  - Route discovery (`discoverRoutes` or equivalent, exported/testable) matches
    assay behavior: given seed URL and seed snapshot links, return at most
    `max(0, maxPages - 1)` additional routes discovered only from the seed page.
    Routes are normalized to `scheme://host/path?query` (no fragment), bounded to
    the seed's http(s) origin, and exclude fragment-only/empty links, `download`
    links, non-http(s)/mailto/tel/javascript/data/blob schemes, external hosts,
    destructive/API paths (`/logout`, `/signout`, `/sign-out`, `/delete`,
    `/remove`, `/unsubscribe`, `/api/`), and common binary/asset suffixes
    (`.pdf`, `.zip`, archives, images/media/fonts/styles/scripts/data/text, and
    other non-HTML assets per assay). Duplicates and the normalized seed are not
    returned.
  - Multi-route evaluation: when multiple page views are provided/captured for a
    crawl, each implemented browser check is evaluated per view and merged into a
    single outcome with assay-compatible semantics/metadata (`crawled`,
    `page_count`, `routes` status list, merged findings/evidence/status/actual
    summary across routes, and `routes_not_evaluated` when a non-load check
    cannot be evaluated due to navigation-failed routes). `browser.load` remains
    evaluable on navigation-failed views; non-load checks on navigation-failed
    routes are skipped from evaluation for that route and reported as not
    evaluated rather than crashing.
  - `runBrowserChecks` supports crawl inputs/options: `crawl` and `maxPages`
    (and/or `max_pages`) plus injected `pageViews`/`views` for deterministic
    tests. When runtime is available and crawl is enabled without injected
    views, it attempts a best-effort bounded same-origin crawl from the captured
    seed view (discover routes then navigate/capture additional pages) before
    multi-route evaluation. Disabled/unavailable degradation and unsupported-check
    blocking behavior remain unchanged.
  - Tests at `packages/browser/test/browser-crawl.test.ts` cover route discovery
    bounds/filtering/normalization (same-origin only, exclusions, dedupe,
    max-pages) and multi-route merged evaluation/metadata (including a crawled
    404/navigation-failed route producing a load finding while other checks skip
    unevaluable routes and report `routes_not_evaluated`). Existing browser tests
    continue to pass. Evidence recorded at
    `docs/parity/evidence/LEM-054-browser-crawl-test-output.txt`.
  - Parity inventory updated for LEM-054 scope: D42, `harness/browser.py`, and
    browser smoke/capture/crawl test mapping rows note bounded same-origin crawl
    and evidence.
  - `pnpm --filter @lemma/browser typecheck`, `pnpm --filter @lemma/browser build`,
    `pnpm lint`, and `pnpm exec vitest run packages/browser/test/browser-crawl.test.ts` pass.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-crawl.test.ts`
- **Evidence:** `packages/browser/src/checks.ts`, `packages/browser/src/runtime.ts`, `packages/browser/src/index.ts` (exports via checks), `packages/browser/test/browser-crawl.test.ts`, `docs/parity/evidence/LEM-054-browser-crawl-test-output.txt`; parity inventory rows D42, `harness/browser.py`, and browser crawl test mapping updated (LEM-054 bounded same-origin crawl slice). Commit/remote recorded in completion summary.

### LEM-053 — Port the browser accessibility check


- **Epic:** E5 Browser and Operate Layer
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-050
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-accessibility.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm exec vitest run packages/browser/test/browser-accessibility.test.ts` 5/5 and full browser suite 22/22, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Port the `browser.accessibility` check from assay into
  `@lemma/browser`. The evaluator must produce deterministic accessibility
  findings from captured DOM/snapshot observations (automated checks floor, not a
  conformance claim) and be executable through the browser runtime when available.
- **Acceptance Criteria:**
  - `@lemma/browser` implements an assay-parity evaluator for
    `browser.accessibility` over captured observations (snapshot
    images/inputs/controls/duplicateIds/positiveTabindex/lang, navigation/final
    URL, and evidence refs) covering:
    - images missing an `alt` attribute (`altPresent` false) -> medium
      accessibility finding (domain/strength/tags/location/repro/remediation/
      verification) listing selectors;
    - form controls lacking a programmatic label (`hasLabel` false) excluding
      `hidden`, `submit`, `button`, `reset`, and `image` input types -> medium
      accessibility/forms finding;
    - interactive controls with no accessible name -> medium accessibility/
      controls finding;
    - duplicate element ids -> low accessibility/dom finding listing ids;
    - positive tabindex values (`positiveTabindex > 0`) -> low accessibility/
      keyboard finding on final URL;
    - missing document language (`lang` empty/whitespace) -> low accessibility/
      language finding on final URL.
  - Outcome `actual` formatted as `{} image(s) without alt; {} unlabeled control(s); {} unnamed control(s); {} duplicate id(s).`, `metadata.manual_review_required` set to `true`, status passed only when no findings, and evidence attached as common evidence.
  - Evaluator exported/testable without Playwright and respects navigation-failure
    blocking for non-load checks. `IMPLEMENTED_BROWSER_CHECKS`/runtime
    integration include `browser.accessibility` so it is no longer degraded as
    "not implemented in this slice" when runtime/observations are available.
  - Tests at `packages/browser/test/browser-accessibility.test.ts` cover pass and
    key finding cases (images, unlabeled inputs with excluded types, unnamed
    controls, duplicate ids, positive tabindex, missing lang, manual-review
    metadata/actual) and runtime integration from injected observations. Existing
    browser tests continue to pass.
  - Parity inventory `harness/browser.py` row updated for the LEM-053 browser
    accessibility evaluator slice with evidence
    `docs/parity/evidence/LEM-053-browser-accessibility-test-output.txt`.
  - `pnpm --filter @lemma/browser typecheck`, `pnpm --filter @lemma/browser build`,
    `pnpm lint`, and `pnpm exec vitest run packages/browser/test/browser-accessibility.test.ts` pass.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-accessibility.test.ts`
- **Evidence:** `packages/browser/src/checks.ts`, `packages/browser/test/browser-accessibility.test.ts`, `packages/browser/test/browser-checks.test.ts` (unsupported-check regression updated), `docs/parity/evidence/LEM-053-browser-accessibility-test-output.txt`; parity inventory `harness/browser.py` updated (LEM-053 browser.accessibility slice). Commit/remote recorded in completion summary.

### LEM-052 — Port the browser security check


- **Epic:** E5 Browser and Operate Layer
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-050
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-security.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm exec vitest run packages/browser/test/browser-security.test.ts` 6/6 and full browser suite 17/17, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Port the `browser.security` check from assay into
  `@lemma/browser`. The evaluator must assess live-response security posture from
  captured navigation headers/cookies and snapshot resources, producing
  assay-parity findings and summaries, and be executable through the browser
  runtime when available.
- **Acceptance Criteria:**
  - `@lemma/browser` implements an assay-parity evaluator for `browser.security`
    over captured observations (navigation final URL/status context, response
    headers, snapshot scripts/links/forms, and cookies/evidence refs) covering:
    - plain HTTP target finding when final URL is not HTTPS;
    - missing baseline security headers finding (HSTS required on HTTPS;
      Content-Security-Policy or report-only accepted; X-Content-Type-Options;
      frame protection via `X-Frame-Options` or `frame-ancestors` in CSP;
      Referrer-Policy) with correct title/list and severity/domain/strength/tags;
    - mixed/insecure content finding on HTTPS pages when snapshot scripts,
      links, or form actions use `http://`;
    - insecure form submission finding for `http://` form actions;
    - weak session-like cookie finding when cookie names suggest session/auth/
      token/jwt and lack Secure or HttpOnly flags (location lists affected
      cookie names);
    - `actual` summary formatted as `HTTPS={bool}; missing headers: {list|none}; mixed content: {count}; weak cookies: {count}` and passed status only when no findings.
  - Evaluator is exported/testable without launching Playwright and respects
    navigation-failure blocking for non-load checks consistent with runner
    behavior. `IMPLEMENTED_BROWSER_CHECKS`/runtime integration include
    `browser.security` so it is no longer degraded as "not implemented in this
    slice" when runtime/observations are available.
  - Tests at `packages/browser/test/browser-security.test.ts` cover pass and key
    finding cases (HTTP target, missing headers, mixed content/insecure forms,
    weak cookies) and runtime integration from injected observations. Existing
    browser tests continue to pass.
  - Parity inventory `harness/browser.py` row updated for the LEM-052 browser
    security evaluator slice with evidence
    `docs/parity/evidence/LEM-052-browser-security-test-output.txt`.
  - `pnpm --filter @lemma/browser typecheck`, `pnpm --filter @lemma/browser build`,
    `pnpm lint`, and `pnpm exec vitest run packages/browser/test/browser-security.test.ts` pass.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-security.test.ts`
- **Evidence:** `packages/browser/src/checks.ts`, `packages/browser/test/browser-security.test.ts`, `docs/parity/evidence/LEM-052-browser-security-test-output.txt`; parity inventory `harness/browser.py` updated (LEM-052 browser.security slice). Commit/remote recorded in completion summary.

### LEM-051 — Port load, console, network, content, and link checks


- **Epic:** E5 Browser and Operate Layer
- **Priority:** P0
- **Points:** 8
- **Depends on:** LEM-050
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-checks.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm exec vitest run packages/browser/test/browser-checks.test.ts` 8/8 and `packages/browser/test/browser-runtime.test.ts` 3/3, plus `pnpm --filter @lemma/browser typecheck/build` and `pnpm lint` pass.
- **Description:** Port the core browser check evaluators for `browser.load`,
  `browser.console`, `browser.network`, `browser.content`, and `browser.links`
  from assay into `@lemma/browser`. Provide deterministic, unit-testable
  evaluation over captured page observations and integrate these checks into the
  browser runtime so available-browser execution can produce real outcomes (with
  unavailable/disabled paths still degrading to blocked per LEM-050).
- **Acceptance Criteria:**
  - `@lemma/browser` implements assay-parity evaluators for `browser.load`,
    `browser.console`, `browser.network`, `browser.content`, and `browser.links`
    over captured page observations (navigation URL/final URL/status/error,
    response headers as needed, DOM snapshot fields, console/page errors, network
    entries, and evidence refs). Outcomes match assay behavior for status,
    `actual` summaries, evidence attachment, and findings (title, severity,
    domain, strength, consequence, location, reproduction, remediation,
    verification, tags) including pass cases and representative failure cases
    (navigation/HTTP/empty-title/low-content failures for load; console/page
    errors; failed/non-success requests with favicon/aborted-request handling for
    network; heading/title-structure issues for content; placeholder/javascript/
    insecure/unsafe-target links for links).
  - Evaluators are exported/testable without launching Playwright (pure
    observation/view input). `browser.load` remains evaluable when navigation did
    not complete; other checks are blocked by navigation failure when invoked in
    a navigation-failed context consistent with assay's runner behavior.
  - Runtime integration: when browser execution is disabled or runtime is
    unavailable, `runBrowserChecks` preserves LEM-050 blocked degradation (no
    regression). When runtime is available, `runBrowserChecks` can evaluate the
    requested checks from this slice (supporting injected/captured observations
    for deterministic tests and a basic Playwright-backed capture path for real
    runs), and degrades any browser check id outside this slice as a blocked
    outcome with an actionable "not implemented in this slice" blocker (never
    passed/failed).
  - Tests at `packages/browser/test/browser-checks.test.ts` cover evaluator
    behavior for all five checks (pass and key finding cases) and runner
    behavior for implemented vs unsupported checks / navigation-failure blocking.
    Existing `packages/browser/test/browser-runtime.test.ts` continues to pass.
    Evidence recorded at `docs/parity/evidence/LEM-051-browser-checks-test-output.txt`.
  - Parity inventory updated for LEM-051 scope: `harness/browser.py` and
    browser smoke/capture/crawl test mapping rows note the load/console/network/
    content/links evaluator slice and evidence.
  - `pnpm --filter @lemma/browser typecheck`, `pnpm --filter @lemma/browser build`,
    `pnpm lint`, and `pnpm exec vitest run packages/browser/test/browser-runtime.test.ts packages/browser/test/browser-checks.test.ts` pass.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-checks.test.ts`
- **Evidence:** `packages/browser/src/checks.ts`, `packages/browser/src/runtime.ts`, `packages/browser/src/index.ts`, `packages/browser/test/browser-checks.test.ts`, `docs/parity/evidence/LEM-051-browser-checks-test-output.txt`; parity inventory `harness/browser.py` and browser test mapping rows updated (LEM-051 evaluator slice). Commit/remote recorded in completion summary.

### LEM-050 — Add the optional Playwright runtime and blocked degradation


- **Epic:** E5 Browser and Operate Layer
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-013
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm exec vitest run packages/browser/test/browser-runtime.test.ts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm exec vitest run packages/browser/test/browser-runtime.test.ts` 3/3, `pnpm --filter @lemma/browser typecheck`, `pnpm --filter @lemma/browser build`, and `pnpm lint` pass.
- **Description:** Add the optional Playwright-backed browser runtime foundation in
  `@lemma/browser` with deterministic blocked degradation when the runtime is
  unavailable. Missing Playwright/Chromium or a disabled browser must block
  browser checks with structured, actionable blockers (never pass, never fail the
  run), so later Operate checks (LEM-051+) can execute on a stable runtime API.
- **Acceptance Criteria:**
  - `@lemma/browser` exports an optional runtime API loaded without hard-importing
    Playwright at module load: `BrowserUnavailableError` (typed, actionable), a
    runtime availability/load helper (e.g. `probeBrowserRuntime`/`loadPlaywright`)
    that dynamically imports Playwright and reports unavailability when the
    package or Chromium launch is unavailable, and browser option/result types
    needed by the runner (including disabled/no-browser mode).
  - Blocked degradation: a browser check execution entry point (e.g.
    `runBrowserChecks(url, checks, onOutcome, options)`) degrades unavailable or
    disabled runtime by emitting one `CheckOutcome` per planned browser check with
    `status: "blocked"`, no findings, `metadata.limitation`/actual describing the
    browser boundary, and a `BlockerDraft` containing `attempted_action`,
    boundary text mentioning browser/Playwright/Chromium unavailability, and
    actionable `unblock_evidence` hints (install Playwright/Chromium or provide a
    runnable browser target, then rerun). The helper must not throw for
    unavailability/disabled degradation and must invoke the outcome callback for
    every supplied check so the harness can continue.
  - Playwright remains an optional peer dependency of `@lemma/browser`; core
    installs/builds are unaffected (no hard Playwright import from `@lemma/core`).
  - Tests at `packages/browser/test/browser-runtime.test.ts` verify: simulated
    unavailable/missing runtime produces one blocked outcome+blocker per browser
    check with no findings and actionable boundary/hints; disabled/no-browser mode
    produces the same blocked degradation contract; degradation does not throw and
    does not mark checks passed/failed. Evidence recorded at
    `docs/parity/evidence/LEM-050-browser-runtime-test-output.txt`.
  - Parity inventory updated for LEM-050 scope: D2 row (missing browser blocks
    checks, never fails run) and `harness/browser.py` row note runtime/blocked
    degradation slice with evidence.
  - `pnpm --filter @lemma/browser typecheck`, `pnpm --filter @lemma/browser build`,
    and `pnpm exec vitest run packages/browser/test/browser-runtime.test.ts` pass.
- **Verification:** `pnpm exec vitest run packages/browser/test/browser-runtime.test.ts`
- **Evidence:** `packages/browser/src/runtime.ts`, `packages/browser/src/index.ts`, `packages/browser/test/browser-runtime.test.ts`, `docs/parity/evidence/LEM-050-browser-runtime-test-output.txt`; parity inventory D2 and `harness/browser.py` updated (LEM-050 runtime/blocked-degradation slice). Commit/remote recorded in completion summary.

### LEM-049 — Port tool capability enforcement and persona conformance tests


- **Epic:** E4 Specialist Persona Layer
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-043, LEM-044
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test persona-conformance`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm --filter @lemma/core test persona-conformance` 5/5, `pnpm lint`, `pnpm --filter @lemma/core typecheck`, and the core build pass.
- **Description:** Complete the persona layer with tool capability enforcement and
  a shipped-persona conformance suite. Persona contracts must declare only
  well-formed tool capabilities, and the three specialist contracts must satisfy
  the full load/schema/ownership/catalog conformance invariants.
- **Acceptance Criteria:**
  - Tool capability enforcement: persona frontmatter `tools` entries are
    validated as non-empty, unique capability identifiers matching
    `^[a-z][a-z0-9_]*$` during contract loading (`loadPersona`/`personaFromDocument`);
    invalid or duplicate tool capabilities raise deterministic `PersonaError`s,
    and `lintPersonas` reports them without stopping at first failure.
    `TOOL_CAPABILITY_PATTERN` and `validatePersonaToolCapabilities` (or
    equivalent exported API) are available from `@lemma/core/personas` and the
    root entry point.
  - Persona conformance tests at
    `packages/core/test/persona-conformance/persona-conformance.test.ts` port and
    adapt assay `test_personas.py` for lemma's shipped contracts: the three
    specialists load with non-empty domains/tools/checks and valid object schemas;
    every referenced check exists in `catalogIds()`; ownership is disjoint and
    covers the full catalog (`checkOwnership`/`validateOwnership`); each
    specialist schema accepts a valid payload for an owned domain and rejects a
    payload missing a required field or carrying an out-of-contract severity;
    malformed contracts (missing required section, invalid/duplicate tool
    capability) raise `PersonaError`.
  - Existing persona contracts (`packages/personas/*.md`) and scaffold output
    remain valid under tool capability enforcement.
  - No runtime dependency added, parity inventory rows for
    `harness/personas.py`/`test_personas.py` (LEM-049) updated, and acceptance
    test plus typecheck/lint/build pass. Evidence recorded under
    `docs/parity/evidence/LEM-049-persona-conformance-test-output.txt`.
- **Verification:** `pnpm --filter @lemma/core test persona-conformance`
- **Evidence to record:** persona-conformance test output and updated parity inventory.

### LEM-048 — Port `personas scaffold`

- **Epic:** E4 Specialist Persona Layer
- **Priority:** P2
- **Points:** 3
- **Depends on:** LEM-047
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test persona-scaffold`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm --filter @lemma/core test persona-scaffold` 4/4, `pnpm lint`, `pnpm --filter @lemma/core typecheck`, and the core build pass.
- **Description:** Port assay's persona scaffold core API to generate a valid
  starter specialist contract atomically. The scaffold must produce a contract
  that lints clean (with expected placeholder warning behavior) and supports the
  same validation/overwrite semantics as assay.
- **Acceptance Criteria:**
  - `scaffoldPersona(personaId, directory, options?)` is exported from
    `@lemma/core/personas` (and root) and returns a
    `quality-harness.personas.scaffold/v1` result with `status`
    (`created`/`overwritten`/`refused`), `persona_id`, `path`, `force`,
    `domains`, `checks`, `reason`/`next_steps` as applicable.
  - Validation matches assay: persona id/name/domains/checks validated with
    deterministic `PersonaError`s (including duplicate check ids). Defaults:
    name derived from id, domain `[personaId]`, check
    `["plugin.<personaId>.placeholder"]`.
  - Generated template includes required frontmatter
    (`id/name/version/domains/tools/checks`), `## Role`,
    `## Available tools`, `## Output schema`, `## Blocker schema`,
    `## Refusal handling`; output/blocker schemas require all core fields and
    include `domain` enum over scaffold domains and standard severity/strength
    enums.
  - File behavior: refuses without overwrite when the target exists and `force`
    is false (no mutation), errors if target path is a directory, writes
    atomically (`0644`) and reports `created` vs `overwritten`.
  - A scaffolded contract (with shipped personas and known catalog checks)
    passes `lintPersonas` unchanged except for the expected
    `plugin_check_placeholder` warning for the default placeholder check.
  - Tests at `packages/core/test/persona-scaffold/persona-scaffold.test.ts`
    cover: successful scaffold + load/lint behavior, refuse-without-force and
    force overwrite, domain/name/check options, validation errors, and
    directory-path error. Evidence is recorded under
    `docs/parity/evidence/LEM-048-persona-scaffold-test-output.txt`.
  - No runtime dependency added, parity inventory rows for
    `harness/personas.py`/`lemma personas scaffold`/`test_persona_tools.py`
    (scaffold portion) updated, and acceptance test plus typecheck/lint/build
    pass.
- **Verification:** `pnpm --filter @lemma/core test persona-scaffold`
- **Evidence to record:** persona-scaffold test output and updated parity inventory.

### LEM-047 — Port `personas lint`

- **Epic:** E4 Specialist Persona Layer
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-041, LEM-044
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test persona-lint`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm --filter @lemma/core test persona-lint` 4/4, `pnpm lint`, `pnpm --filter @lemma/core typecheck`, and the core build pass.
- **Description:** Port assay's aggregate persona contract linting as a core API.
  Lint scans a persona directory without stopping at the first failure and reports
  load/frontmatter/schema/ownership/registry issues in the
  `quality-harness.personas.lint/v1` shape so the CLI can expose deterministic
  diagnostics later.
- **Acceptance Criteria:**
  - `lintPersonas(directory, knownCheckIds?)` is exported from
    `@lemma/core/personas` (and the root entry point) and returns a report with
    `schema_version: "quality-harness.personas.lint/v1"`, `directory`,
    `status`, `known_check_count`, `personas`, `errors`, `warnings`, and
    `summary { files, valid_personas, errors, warnings }`.
  - Missing directory and empty/no-persona directories produce
    `directory_missing` / `no_persona_files` errors with assay-compatible
    messages; scanning is deterministic over sorted non-README `*.md` files.
  - Load failures become lint errors (not thrown) with file/message and mapped
    codes: `missing_section`, `frontmatter`, `schema`, `empty_section`, or
    `invalid_persona`. Duplicate persona ids produce `duplicate_persona_id`
    errors (including the previously declared file) and are excluded from valid
    loaded personas.
  - Loaded personas receive schema lint diagnostics attached with file/persona/
    schema/field: `schema_required_field_missing`,
    `schema_property_not_defined`, `schema_property_invalid`,
    `schema_type_unsupported`, `schema_enum_invalid`, `schema_items_invalid`.
  - Ownership/registry diagnostics over loaded personas use assay-compatible
    behavior: `duplicate_ownership` errors with owners/message; known check ids
    accepted; scaffold placeholder checks `plugin.<persona_id>.*` unknown to the
    registry produce `plugin_check_placeholder` warnings; other unknown checks
    produce `unknown_check` errors with owners/message.
  - Tests at `packages/core/test/persona-lint/persona-lint.test.ts` cover a
    clean shipped persona set linting valid with known built-in checks, and the
    required failure/warning categories (missing section/frontmatter-schema
    mapping as applicable, duplicate id, duplicate ownership, unknown check,
    schema required-field/property issues, and placeholder warning) matching
    assay lint semantics. Evidence is recorded under
    `docs/parity/evidence/LEM-047-persona-lint-test-output.txt`.
  - No runtime dependency is added, parity inventory rows for
    `harness/personas.py`/`lemma personas lint`/`test_persona_tools.py` (lint
    portion) are updated, and the acceptance test plus typecheck/lint/build pass.
- **Verification:** `pnpm --filter @lemma/core test persona-lint`
- **Evidence to record:** persona-lint test output and updated parity inventory.

### LEM-046 — Port structured blocker and refusal records

- **Epic:** E4 Specialist Persona Layer
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-042
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test blockers`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm --filter @lemma/core test blockers` 6/6, `pnpm lint`, `pnpm --filter @lemma/core typecheck`, and the core build pass.
- **Description:** Port assay's structured refusal/blocker handling: every blocked
  check produces exactly one redacted blocker record (or reuses an existing one),
  blocked outcomes discard findings, a passed outcome carrying a blocker is forced
  to blocked, and blocker payloads are derived/validated against the owning persona
  blocker contract. Recording must integrate with existing check state, coverage,
  report, and resume behavior.
- **Acceptance Criteria:**
  - A new `@lemma/core/outcomes` module (exported from the root entry point and
    as the `@lemma/core/outcomes` subpath, and added to the core build) ports
    assay's blocker/refusal recording:
    - `blockerPayload` derives a raw payload from a `BlockerDraft` or fallback
      values (attempted action from draft/check expected/title/id; boundary from
      draft/explicit boundary/outcome actual/metadata boundary/limitation/check
      actual/skip reason/default text; unblock evidence from the draft, or
      `[metadata.note]` when string, else a deterministic hint for
      persona-owner, plugin/signature/trust, browser/playwright/chromium/operate,
      source/static/inventory, or generic boundaries; covered_elsewhere/covered_by
      normalized).
    - `blockerFromPayload`/recording creates a redacted `Blocker` with
      deterministic id/timestamp, validates it against the persona's
      `blocker_schema` when a persona is present and logs a warning on contract
      violations (matching assay), appends at most one blocker per `check_id`,
      forces the check to `blocked`, clears `finding_ids` and removes findings
      for that check, and sets `skip_reason` from the limitation/boundary.
    - `recordCheckOutcome` applies a `CheckOutcome` to `RunStateDomain`: sets
      evidence, redacts/sets actual and metadata appropriately, treats blocked
      status or any blocker draft (including existing blocker) as a refusal that
      discards finding drafts with a warning, records the blocker once, and for
      non-blocked outcomes records findings through `recordCheckFindings`.
      Completed terminal statuses receive `completed_at`; skipped checks record a
      skip reason.
  - Persona blocker schema validation remains available (`validateBlocker` /
    `validatePayload`), and runtime blocker records are checked against the
    owning persona blocker contract.
  - Blockers remain visible in state/report/coverage (one per blocked check,
    by-domain/by-persona counts, covered/uncovered totals) and are redacted before
    persistence; resume/rerun pruning continues to drop blockers for rerun checks.
  - Tests at `packages/core/test/blockers/blockers.test.ts` cover: blocked
    outcome produces exactly one blocker and no findings; passed outcome with a
    blocker is forced to blocked; finding drafts are discarded for blocked
    outcomes; duplicate recording is a no-op after the first blocker; fallback
    payload derivation and unblock hints; blocker/actual/metadata redaction in
    persisted progress; persona blocker-contract warning path; coverage/report
    blocker totals; and non-blocked `recordCheckOutcome` finding/quarantine flow.
    Evidence is recorded under
    `docs/parity/evidence/LEM-046-blockers-test-output.txt`.
  - No runtime dependency is added, the parity inventory rows for
    `harness/outcomes.py` (LEM-046), blocker schema validation, `test_blockers.py`,
    and D18 are updated, and the acceptance test plus typecheck/lint/build pass.
- **Verification:** `pnpm --filter @lemma/core test blockers`
- **Evidence to record:** blockers test output, updated parity inventory rows,
  package export/build updates, and Decision Log entry if module boundaries
  change.

### LEM-045 — Port invalid-finding quarantine and degraded streaks

- **Epic:** E4 Specialist Persona Layer
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-013, LEM-042
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test invalid-findings`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm --filter @lemma/core test invalid-findings` 7/7, related report/resume/conformance suites pass, `pnpm --filter @lemma/core typecheck`, `pnpm lint`, and the core build pass.
- **Description:** Port assay's execution-time persona output-contract handling:
  extract finding drafts without inventing missing fields, validate each draft
  against its owning persona schema, quarantine invalid drafts outside scoring
  and kill-switch evaluation, maintain per-persona contract-failure totals and
  consecutive streaks, mark a persona degraded after three consecutive failures,
  reset the streak on a valid finding, and rebuild the counters after resume
  pruning. The report/model/resume fields added by earlier tasks are reused, not
  duplicated.
- **Acceptance Criteria:**
  - A new `@lemma/core` findings module (exported from the root entry point and
    documented in `docs/architecture.md`) ports assay's raw-payload extraction
    without deriving defaults: missing fields stay absent, non-object drafts
    become `{ value: draft }`, and a throwing getter never aborts the run.
  - `findingFromPayload` builds a `Finding` with the check's `persona` and
    `check_id`, falls back to check evidence when the draft has none, and uses
    assay's `sha256("<domain>|<trimmed-lowercase-title>|<location>|<severity>")`
    first-16-hex fingerprint.
  - `quarantineFinding` appends an `InvalidFinding` with
    `contract: "persona_output_schema"`, deterministic id/timestamp through the
    injected clock/entropy providers, redacted error strings and payload, and
    increments `contract_failures` plus `contract_failure_streaks`; the persona
    is appended once to `degraded_personas` when the streak reaches three.
  - `recordValidContract` resets a non-zero streak to zero and leaves the
    degraded list unchanged, matching assay. `rebuildContractHealth` recomputes
    failures, streaks, and degraded personas from the remaining invalid records
    (used by resume after rerun pruning).
  - `recordCheckFindings(state, check, drafts, persona)` validates each draft
    against the persona output schema, quarantines invalid drafts, records valid
    findings with fingerprint de-duplication, evidence merge, and
    `check.finding_ids` linkage, resets the streak for each valid finding, and
    sets `check.metadata.invalid_findings` to the invalid count. When no persona
    contract is supplied, validation errors are empty, matching assay.
  - Invalid findings never enter `state.findings`, confidence scoring, or
    kill-switch evaluation. Quarantined payloads and errors are redacted before
    they can reach `progress.json` or the report.
  - The orchestrator resume path uses the shared `rebuildContractHealth` helper
    instead of a private duplicate, preserving rerun-pruning behavior.
  - The report continues to expose sorted `invalid_findings`, aggregate
    `contract_failures` (`total`, `by_persona`, `degraded_personas`), per-persona
    `contract_failures`/`contract_failure_streak`/`degraded`, and the quarantine
    and degradation limitation notes.
  - Tests at `packages/core/test/invalid-findings/invalid-findings.test.ts`
    cover: three invalid drafts quarantined without scoring or killing; exact
    enum/nested-type/missing-field errors; a valid finding resetting the streak;
    valid-finding de-duplication and evidence linkage; payload extraction with
    missing/throwing fields; redaction; and contract-health rebuild after
    pruning. Evidence is recorded under
    `docs/parity/evidence/LEM-045-invalid-findings-test-output.txt`.
  - No runtime dependency is added, the parity inventory rows for
    `test_invalid_findings.py`, finding-schema validation, and D17 are updated,
    and the acceptance test plus typecheck/lint/build pass.
- **Verification:** `pnpm --filter @lemma/core test invalid-findings`
- **Evidence to record:** invalid-findings test output, updated parity inventory
  rows, architecture module map, and Decision Log entry.

### LEM-044 — Port ownership derivation and disjointness enforcement

- **Epic:** E4 Specialist Persona Layer
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-014, LEM-041
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test ownership`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm --filter @lemma/core test ownership` 10/10, persona/checks regression suites pass, `pnpm --filter @lemma/core typecheck`, `pnpm lint`, and core/personas builds pass.
- **Description:** Port assay's ownership derivation and disjointness helpers from
  `harness/personas.py` into `@lemma/core/personas`, wire the planner to the
  shared assay-compatible ownership error message, and make the full lemma check
  catalog resolve to exactly one persona owner. Because LEM-037 added 52
  lemma-only intent-gated `static.category.<label>` scope markers that assay does
  not have, the functional contract's `checks` frontmatter is extended with those
  scope markers; the three ported contracts' bodies, domains, tools, and schemas
  stay unchanged. This deliberately supersedes LEM-043's assay check-list parity
  for `functional.md` while keeping frontmatter as the only ownership source.
- **Acceptance Criteria:**
  - `checkOwnership(personas)` derives a `Record<string, string[]>` from persona
    frontmatter only: every declared check id maps to the sorted persona ids that
    claim it, preserving first-seen key order, accepting `Persona` or any
    structural `{ id, checks }`, and never reading `CHECK_CATALOG.persona`.
  - `ownershipErrorMessage(checkId, owners)` returns assay-compatible
    deterministic text: no owner yields
    `Check '<id>' has no declared persona owner; it must be listed by exactly one persona contract.`
    and multiple owners yields
    `Check '<id>' is claimed by multiple personas (<sorted ids>); it must be listed by exactly one persona contract.`
  - `unknownPersonaCheckIds(personas, knownCheckIds)` returns deterministic
    `[personaId, checkId]` pairs, and `validatePersonaChecks(...)` throws a typed
    `PersonaError` naming the first persona and every unique unknown check id,
    matching assay.
  - `validateOwnership(personas, knownCheckIds)` rejects unknown declared ids,
    then requires every known check id to have exactly one owner; an unowned or
    multiply owned id throws `PersonaError` using `ownershipErrorMessage`, and a
    valid set returns the derived ownership map. Inputs are not mutated and the
    error order is deterministic.
  - The functional contract frontmatter declares all 52 lemma-only
    `static.category.<label>` scope checks, so
    `validateOwnership(loadPersonas(...), catalogIds())` succeeds and derived
    ownership covers exactly the 76 catalog ids with one owner each; catalog
    definitions retain `persona: ""`, so frontmatter remains the only owner
    source.
  - `planChecks` uses the single shared `ownershipErrorMessage` from
    `personas.ts` (assay wording) for built-in unowned/multiply owned checks and
    still degrades plugin ownership failures to blocked coverage gaps; the
    existing planner tests are updated to the new message.
  - Tests at `packages/core/test/ownership/ownership.test.ts` cover derivation,
    full catalog coverage, both error messages, unknown ids, duplicate
    ownership, unowned `static.inventory` planning failure, valid planning with
    frontmatter-derived ownership, and selected-persona planning using the full
    ownership map; the LEM-043 contract test still verifies the assay-owned
    functional subset and now verifies the lemma-only scope markers.
  - The ownership helpers are exported from `@lemma/core` and
    `@lemma/core/personas`, no runtime dependency is added, and evidence is
    recorded under
    `docs/parity/evidence/LEM-044-ownership-test-output.txt`.
- **Verification:** `pnpm --filter @lemma/core test ownership`
- **Evidence recorded:** `docs/parity/evidence/LEM-044-ownership-test-output.txt`
  (10/10), `docs/parity/evidence/LEM-044-functional-contract-extension.txt`
  (only additive `static.category.*` frontmatter lines vs assay), updated parity
  inventory rows, and Decision Log DL12. Regression runs:
  `pnpm --filter @lemma/core test persona` (22/22) and
  `pnpm --filter @lemma/core test checks` (15/15).

### LEM-043 — Port the functional, security, and accessibility contracts

- **Epic:** E4 Specialist Persona Layer
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-041, LEM-042
- **Status:** Done
- **Claimed:** 2026-11-15 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test persona-contracts`.
- **Completed:** 2026-11-15 — all acceptance criteria pass; `pnpm --filter @lemma/core test persona-contracts` 7/7, `pnpm --filter @lemma/core typecheck`, `pnpm lint`, and builds for `@lemma/core`/`@lemma/personas` pass; `npm pack --dry-run` ships the four Markdown contracts.
- **Description:** Port assay's three built-in specialist contracts
  (`personas/functional.md`, `personas/security.md`,
  `personas/accessibility.md`) and the `personas/README.md` authoring rules into
  `packages/personas/`, and add the deterministic loader that turns those
  Markdown files into validated `Persona` objects using the LEM-041 parser and
  LEM-042 schema validator.
- **Acceptance Criteria:**
  - `packages/personas/functional.md`, `security.md`, `accessibility.md`, and
    `README.md` are ported from assay with identical content (verified by a
    `diff -rq` against the assay checkout), preserving each contract's id, name,
    version, domains, tools, declared checks, role, tool table, output schema,
    blocker schema, and refusal section.
  - `loadPersona(path)` reads a UTF-8 persona, parses frontmatter/sections, and
    enforces: required non-empty frontmatter keys `id`, `name`, `domains`,
    `tools`, `checks`; `domains`/`tools`/`checks` are lists; all required
    sections exist (`role`, `available tools`, `output schema`, `blocker schema`,
    `refusal handling`); the output and blocker schemas pass
    `extractJsonSchema`; and the role and refusal sections are non-empty. Each
    failure throws a typed `PersonaError` (`errorCode === "persona_error"`) with
    a deterministic assay-compatible message.
  - `loadPersonas(directory, { selected?, requireMinimum? })` (default minimum
    3) lists sorted `*.md` files, skips `README*.md` case-insensitively, rejects
    duplicate ids, empty directories, unknown selected ids, and too few
    personas, preserving contract order; `selectPersonas` returns a requested
    subset and `personaPublic` exposes the assay-compatible public projection
    (id/name/version/domains/tools/checks/path/schema titles).
  - The `Persona` type exposes `id`, `name`, `version`, `domains`, `tools`,
    `checks`, `path`, `role`, `tools_section`, `output_schema`,
    `blocker_schema`, `refusal`, `body`, and `metadata`; loading
    `packages/personas` yields exactly the three specialists
    (`accessibility`, `functional`, `security`) with the assay domain/tool/check
    ownership lists.
  - End-to-end contract validation works for all three contracts: a valid
    persona-shaped finding (domain from the persona) validates against its
    output schema, an out-of-contract severity is rejected, and a valid
    structured blocker validates against its blocker schema.
  - The loader and public types are exported from `@lemma/core` and the
    `@lemma/core/personas` subpath, the contracts ship in the `@lemma/personas`
    package `files`, no runtime dependency is added, and loading is
    deterministic/text-only.
  - `packages/core/test/persona-contracts/persona-contracts.test.ts` covers the
    three ported contracts, schema/blocker end-to-end validation, loader
    success/error paths, selection, and the public projection; output is
    recorded under
    `docs/parity/evidence/LEM-043-persona-contracts-test-output.txt`.
- **Verification:** `pnpm --filter @lemma/core test persona-contracts`
- **Evidence recorded:** `docs/parity/evidence/LEM-043-persona-contracts-test-output.txt`
  (7/7), `docs/parity/evidence/LEM-043-assay-persona-diff.txt` (all four ported
  files identical to assay), and updated parity inventory rows for
  `personas/*.md` and `harness/personas.py`.

### LEM-042 — Port output and blocker schema validation

- **Epic:** E4 Specialist Persona Layer
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-041
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test persona-schema`.
- **Description:** Port assay's persona output/blocker JSON-Schema subset from
  `harness/personas.py` (`_extract_json_schema`, `validate_payload`,
  `validate_blocker`, `_type_matches`, and the core field/type constants) into
  `@lemma/core/personas`, without adding a JSON-Schema runtime dependency.
- **Acceptance Criteria:**
  - Export assay-compatible contract constants: `CORE_FINDING_FIELDS` (the nine
    required finding fields), `CORE_BLOCKER_FIELDS` (the six required blocker
    fields), and `SUPPORTED_SCHEMA_TYPES` (object/array/string/number/integer/
    boolean/null).
  - `extractJsonSchema(section, label, source?)` extracts the first
    case-insensitive ```` ```json ```` fenced block from a persona section,
    parses it as JSON, and requires: a JSON object (not array/scalar),
    `type === "object"`, a non-empty `required` array, and a non-empty
    `properties` object. Each failure throws a typed `PersonaError`
    (`errorCode === "persona_error"`) with a deterministic message naming the
    source/label (missing fenced block, invalid JSON, non-object, wrong type,
    empty/missing required, empty/missing properties).
  - `validatePayload(payload, schema, path = "$")` ports assay's subset
    validator: declared `type` checked first with early return; `enum`
    membership via deep equality; object `required` keys reported as missing;
    each present declared property validated recursively; array `items`
    validated per index. Errors are deterministic, `$`-rooted path strings, and
    a valid payload returns `[]`. Unknown declared types are treated as
    permissive, matching assay.
  - `validateBlocker(payload, blockerSchema)` validates a structured blocker
    payload against a persona blocker schema using the same engine, so a valid
    blocker returns `[]` and a missing required core blocker field fails.
  - End-to-end persona validation works: `parsePersonaDocument` +
    `extractJsonSchema` over the `output schema`/`blocker schema` sections yields
    usable finding/blocker schemas; assay-style valid finding and blocker
    payloads pass, while an out-of-contract `severity`/`domain` enum value, a
    missing required field, and a wrong primitive type are rejected with the
    correct path/field.
  - The APIs are exported from `@lemma/core` and the `@lemma/core/personas`
    subpath, add no runtime dependency, and are deterministic/text-only.
  - `packages/core/test/persona-schema/persona-schema-validation.test.ts` covers
    constants, schema extraction failure modes, every validator branch, blocker
    validation, and the end-to-end persona flow; output is recorded under
    `docs/parity/evidence/LEM-042-persona-schema-validation-test-output.txt`.
- **Verification:** `pnpm --filter @lemma/core test persona-schema` (targeted: `packages/core/test/persona-schema/persona-schema-validation.test.ts`) — **PASS** (8 tests). `pnpm --filter @lemma/core typecheck`, `pnpm lint`, and `pnpm --filter @lemma/core build` (emits `dist/personas.js`/`dist/personas.d.ts`) passed (2026-11-14).
- **Evidence:** `packages/core/src/personas.ts` (`CORE_FINDING_FIELDS`/`CORE_BLOCKER_FIELDS`/`SUPPORTED_SCHEMA_TYPES`, `matchesSchemaType`, `extractJsonSchema`, `validatePayload`, `validateBlocker`, `PersonaJsonSchema`/`PersonaJsonValue` types), exported from `@lemma/core` and the `@lemma/core/personas` subpath; `packages/core/test/persona-schema/persona-schema-validation.test.ts` (8 tests: constants, fenced schema extraction and failure modes, type/enum/required/nested/array validation, deep-equality enums, blocker validation, end-to-end parsed-persona validation). Test output: `docs/parity/evidence/LEM-042-persona-schema-validation-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-041 — Port the persona frontmatter parser

- **Epic:** E4 Specialist Persona Layer
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-013
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test personas`.
- **Description:** Port assay's persona frontmatter parser (the YAML subset in
  `harness/personas.py`) into `@lemma/core/personas` without adding a runtime
  YAML dependency, so persona contracts can be read deterministically with typed
  errors, and so later tasks can layer schema validation, ownership, and lint on
  top of the same parse.
- **Acceptance Criteria:**
  - `parseFrontmatter(text)` reads a `---`-delimited YAML-subset block and
    returns a key→value map. It requires the opening `---` on the first line and
    a closing `---` line; a missing opening or closing delimiter throws a typed
    `PersonaError` with `errorCode === "persona_error"` and a deterministic
    message.
  - Scalar parsing matches assay `_parse_scalar`: trimmed plain strings; single-
    or double-quoted values unquoted; `true`/`false` (case-insensitive) become
    booleans; `^-?\d+$` becomes an integer; `[a, b]` becomes a recursively
    parsed array (empty `[]` stays empty); an empty value becomes an empty list;
    everything else stays a string.
  - Block-list parsing matches assay `parse_frontmatter`: `- item` lines
    (including indented lines) append `parseFrontmatterScalar(item)` to the
    current key, creating/resetting the key to a list when needed; a list item
    before any key throws `PersonaError`; a non-list frontmatter line without a
    `:` throws `PersonaError`; a later scalar key updates the current key.
  - `splitFrontmatter(text)`/`parsePersonaDocument(text)` separate frontmatter
    from body at the closing delimiter and expose the body, and
    `splitSections(body)` maps `## Heading` titles (trimmed and lowercased) to
    trimmed section bodies, with later duplicate headings winning, matching
    assay `_split_sections`.
  - `readPersonaDocument(path)` reads a UTF-8 persona file and parses it; a read
    failure throws `PersonaError`. Parsing is text-only (no evaluation, no
    filesystem/network access), deterministic, and preserves key insertion
    order, with no clock or entropy use.
  - The parser API is exported from `@lemma/core` and available through the
    `@lemma/core/personas` subpath (`package.json` export + tsup build entry),
    adding no runtime dependency.
  - `packages/core/test/personas/personas.test.ts` covers delimiter/error cases,
    every scalar encoding, block lists, section splitting, a full assay-style
    persona document, and file reading; test output is recorded under
    `docs/parity/evidence/LEM-041-personas-test-output.txt`.
- **Verification:** `pnpm --filter @lemma/core test personas` (targeted: `packages/core/test/personas/personas.test.ts`) — **PASS** (7 tests). `pnpm --filter @lemma/core typecheck`, `pnpm lint`, and `pnpm --filter @lemma/core build` (emits `dist/personas.js`/`dist/personas.d.ts`) passed (2026-11-14).
- **Evidence:** `packages/core/src/personas.ts` (assay-compatible `parseFrontmatterScalar`/`parseFrontmatter`/`splitFrontmatter`/`splitSections`/`parsePersonaDocument`/`readPersonaDocument`, typed `PersonaError`), exported from `@lemma/core` and via `@lemma/core/personas` (`package.json` export + tsup entry); `packages/core/test/personas/personas.test.ts` (7 tests: scalar encodings, full fixture, block lists, malformed frontmatter, section splitting, full document, unreadable file), fixture `packages/core/test/personas/fixtures/fixture-specialist.md`. Test output: `docs/parity/evidence/LEM-041-personas-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-034 — Port full-assessment markers

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-027
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- full-assessment`.
- **Description:** Port the deterministic full-assessment category scope marker
  (`static.full_assessment`) with assay-compatible evidence and outcome.
- **Acceptance Criteria:**
  - Core static runner implements and dispatches `static.full_assessment`,
    saving evidence artifact `full-assessment-scope` (kind `static_analysis`)
    with description `Full category assessment scope and inventory summary.`.
  - Evidence payload includes `category: "full"`, `intent`, `expected`,
    `source_available`, and counts for `source_files`, `test_files`,
    `markup_files`, and `manifests` derived from the inventory/check.
  - Outcome is assay-compatible: passed, actual
    `Full category assessment recorded for ${source_files.length} source file(s).`,
    evidence includes the saved scope artifact, and metadata includes
    `{ category: "full" }`; API exported from `@lemma/core` with tests covering
    payload/actual/metadata/evidence linkage.
- **Verification:** `pnpm --filter @lemma/core test -- full-assessment` (targeted file: `packages/core/test/full-assessment/full-assessment.test.ts`) — **PASS** (1 test). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/static.ts` (`StaticCheckRunner` dispatch/method for `static.full_assessment` with assay-compatible `full-assessment-scope` evidence payload/description, passed outcome actual, and `{category:"full"}` metadata), exported via `@lemma/core`; `packages/core/test/full-assessment/full-assessment.test.ts` (payload, actual, metadata, and evidence linkage). Test output: `docs/parity/evidence/LEM-034-full-assessment-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-037 — Cover the remaining 50+ category commands with owned checks or documented no-ops

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P1
- **Points:** 8
- **Depends on:** LEM-033
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- category-coverage`.
- **Description:** Cover all assay category commands with deterministic owned
  checks or documented no-ops so every category intent is explicitly represented
  in planning/execution and evidence.
- **Acceptance Criteria:**
  - Core defines a canonical, deterministic list of all 59 assay category
    command labels and their intent strings (`Assay <label> assessment`,
    matching assay command semantics) with exported coverage/mapping APIs.
  - For every category intent, planning yields an owned deterministic static
    scope check: existing specialized checks remain for `full`
    (`static.full_assessment`), `test`, `functionality`, `browser` (scope marker
    when live browser unavailable), `issues`, `demo` (scope marker when live
    browser unavailable), and `more`; all remaining category intents plan a
    generic `static.category.<label>` scope-marker check (documented no-op /
    rationale) with stable check definitions in the catalog.
  - Generic category scope checks are executable by `StaticCheckRunner`, saving
    deterministic `static_analysis` evidence (category-scope artifact) recording
    category/label, intent, expected/rationale, source/inventory summary, and
    documented-no-op metadata as applicable; outcomes are passed, evidence-backed,
    and do not invent findings.
  - Intent detection and planning are intent-gated and deterministic: each
    category intent plans its corresponding scope check (and not unrelated
    category scope checks), existing non-category checks continue to plan per
    applicability, and catalog/registry/planning tests are updated accordingly.
  - Tests verify full 59-category intent coverage/mapping and representative
    planning+execution/evidence for generic and specialized categories.
- **Verification:** `pnpm --filter @lemma/core test -- category-coverage` (targeted: `packages/core/test/category-coverage/category-coverage.test.ts`, 3/3) and `pnpm --filter @lemma/core test -- checks` (`packages/core/test/checks/checks.test.ts`, 4/4) — **PASS** (7 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/checks.ts` (canonical `ASSAY_CATEGORY_LABELS`/intents, mapping helpers, generic `static.category.<label>` definitions, intent-gated planning/applicability), `packages/core/src/static.ts` (`StaticCheckRunner` generic category-scope handler with documented no-op `static_analysis` evidence), exports via `packages/core/src/index.ts`; `packages/core/test/checks/checks.test.ts` (catalog/registry/planning compatibility updates), `packages/core/test/category-coverage/category-coverage.test.ts` (full 59-category mapping, intent-gated planning, representative generic execution/evidence). Test output: `docs/parity/evidence/LEM-037-category-coverage-test-output.txt`. Commit/remote recorded in completion summary.
### LEM-040 — Verify static finding-to-evidence linkage and report totals

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-016, LEM-020
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- static-linkage-totals`.
- **Description:** Verify that static check findings are linked to persisted,
  hashed evidence artifacts and that report coverage/finding/evidence totals are
  consistent with executed static checks and materialized findings.
- **Acceptance Criteria:**
  - A deterministic verification test executes static checks that produce
    findings and evidence (e.g. `static.secrets`, `static.unsafe`,
    `static.dependencies` and/or other static checks) via `StaticCheckRunner`
    and `EvidenceStore`, materializes outcomes into run state (checks with
    evidence/status/actual/finding_ids and findings with ids, check_id, and
    evidence paths), finalizes evidence, and builds a `quality-harness.report/v1`
    report.
  - Finding-to-evidence linkage is verified: every static finding references at
    least one evidence path; each finding's evidence paths are present on its
    owning check and in the evidence manifest entries; referenced artifact files
    exist on disk with hashes matching manifest entries and evidence
    verification passes (no missing/mismatched/tampered artifacts).
  - Report totals are verified as consistent: `coverage` totals/percent and
    `by_domain` buckets match checks/statuses/blockers, `finding_counts` match
    finding severities, `evidence.summary` (count/bytes/by_kind/manifest) matches
    the finalized evidence store, and `checks[].finding_ids`/`findings[].check_id`
    are mutually consistent.
  - Verification is deterministic, text-safe, and records evidence/test output.
- **Verification:** `pnpm --filter @lemma/core test -- static-linkage-totals` (targeted: `packages/core/test/static-linkage-totals/static-linkage-totals.test.ts`) — **PASS** (1 test). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/test/static-linkage-totals/static-linkage-totals.test.ts` (deterministic static checks via `StaticCheckRunner`+`EvidenceStore`, materialized checks/findings, evidence finalize+verify, and `buildReport` linkage/totals assertions). Test output: `docs/parity/evidence/LEM-040-static-linkage-totals-test-output.txt`. Commit/remote recorded in completion summary.


### LEM-039 — Build the static precision and recall corpus

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-031, LEM-032
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- static-precision-recall`.
- **Description:** Build a deterministic, reviewable static precision/recall
  corpus for secret and unsafe-code scanning (and related scope/ignore cases)
  with labeled expectations and automated verification.
- **Acceptance Criteria:**
  - A tracked static precision/recall corpus is added under
    `packages/core/test/static-precision-recall-corpus/` containing labeled
    fixture cases/files and a machine-readable manifest describing each case
    (inputs, target files/snippets or fixture refs, and expected outcomes).
  - Corpus covers precision and recall for `static.secrets` and `static.unsafe`
    behaviors aligned with assay parity: true positives detected, true negatives
    not flagged (precision), and required detections present (recall), including
    cases such as member `exec` calls not reported as bare exec/eval while
    bare/dangerous execution and `child_process.exec` are reported, `innerHTML`
    still reported, obvious test/placeholder credentials ignored with counts vs
    real-looking values reported, and scope/ignore cases (e.g. `.harnessignore`
    vendored exclusion/negation affecting scanned sources).
  - Automated tests execute the corpus against core static analysis
    (`SourceInspector`/`StaticCheckRunner` as appropriate) and assert expected
    matches/non-matches, findings/metadata, and statuses deterministically.
  - Corpus and tests are deterministic, text-safe, and contain no live secrets
    (synthetic/fake values only) with evidence recorded.
- **Verification:** `pnpm --filter @lemma/core test -- static-precision-recall` (targeted: `packages/core/test/static-precision-recall-corpus/static-precision-recall.test.ts`) — **PASS** (1 test, 5 corpus cases). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/test/static-precision-recall-corpus/corpus.json` (machine-readable labeled corpus), `packages/core/test/static-precision-recall-corpus/static-precision-recall.test.ts` (deterministic corpus execution over `SourceInspector`/`StaticCheckRunner` for secrets/unsafe and scope cases). Test output: `docs/parity/evidence/LEM-039-static-precision-recall-test-output.txt`. Commit/remote recorded in completion summary.


### LEM-038 — Port the sample-repo, demo-web, and static fixtures

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-027
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: fixture parity checks against `../assay/examples/sample-repo`, `../assay/examples/demo-web`, and `../assay/tests/fixtures`.
- **Description:** Port deterministic static and demo fixtures from assay so
  lemma has parity fixtures for static analysis, category/demo flows, and tests.
- **Acceptance Criteria:**
  - `examples/sample-repo/` is ported to match assay's
    `examples/sample-repo/` fixture (structure and content), including
    `.github/workflows/ci.yml` and existing source/test/manifest/lockfile files,
    preserving deterministic static-analysis signals (representative
    high/medium/low findings) with only clearly fake demo values.
  - `examples/demo-web/` is ported to match assay's `examples/demo-web/`
    fixture (stable accessible browser/demo baseline page and content).
  - Static fixture files from assay `tests/fixtures/` (e.g.
    `redaction_corpus.json`) are ported into lemma under `tests/fixtures/`
    with matching content to support parity/static-fixture usage.
  - Ported fixtures are deterministic, text-safe, and contain no live secrets
    or credentials; parity is evidenced by file/structure comparisons.
- **Verification:** `diff -rq examples/sample-repo ../assay/examples/sample-repo && diff -rq examples/demo-web ../assay/examples/demo-web && diff -rq tests/fixtures ../assay/tests/fixtures` — **PASS** (no differences; exit 0, 2026-11-14).
- **Evidence:** `examples/sample-repo/` (parity with assay, incl. `.github/workflows/ci.yml`), `examples/demo-web/index.html`, `tests/fixtures/redaction_corpus.json`; parity comparison output: `docs/parity/evidence/LEM-038-fixtures-parity.txt`. Commit/remote recorded in completion summary.


### LEM-036 — Port risk tracked-file parity

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P2
- **Points:** 3
- **Depends on:** LEM-024, LEM-027
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- risk-tracked-parity`.
- **Description:** Ensure risk analysis uses git-aware tracked-file scope for
  environment and CI signals so ignored/untracked artifacts do not create false
  committed risks and committed scope remains authoritative.
- **Acceptance Criteria:**
  - When `inventory.tracked_available` is `true`, `RiskAnalyzer` emits the
    "Committed environment files may expose live configuration" risk only when
    `env_files_tracked` is non-empty, using those tracked files in evidence
    (`Committed env files: <first 5 joined by ", ">`); ignored/untracked env
    files present only in `env_files`/`env_files_ignored` do not trigger this risk.
  - When `inventory.tracked_available` is `false`/unavailable, env risk falls
    back to `inventory.env_files` (assay-compatible filesystem fallback).
  - "Test evidence is not refreshed by continuous integration" risk is driven
    by scoped `inventory.ci_files` (empty `ci_files` => risk with evidence
    `No CI configuration found.`). With git-tracked scope represented in
    inventory, untracked-only CI config (absent from scoped `ci_files`) is
    treated as no committed CI.
  - Deterministic, assay-compatible behavior is covered by tests; exported API
    (`RiskAnalyzer`/`analyzeRisk`) remains unchanged.
- **Verification:** `pnpm --filter @lemma/core test -- risk-tracked-parity` (targeted file: `packages/core/test/risk-tracked-parity/risk-tracked-parity.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/risk.ts` (`RiskAnalyzer` tracked-file parity: env risk prefers `env_files_tracked` when `tracked_available`, filesystem fallback otherwise; CI-refresh risk driven by scoped `inventory.ci_files`), `packages/core/test/risk-tracked-parity/risk-tracked-parity.test.ts` (tracked vs ignored/untracked env parity, fallback, and scoped/untracked-only CI parity). Test output: `docs/parity/evidence/LEM-036-risk-tracked-parity-test-output.txt`. Commit/remote recorded in completion summary.


### LEM-035 — Port CI root-scoping precision

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P2
- **Points:** 2
- **Depends on:** LEM-029
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- ci-root-scoping`.
- **Description:** Make CI configuration discovery root-scoped and precise so
  nested or vendored copies of CI config filenames do not produce false CI
  presence signals.
- **Acceptance Criteria:**
  - `SourceInspector` treats CI config filenames (`CI_NAMES`: `.gitlab-ci.yml`,
    `Jenkinsfile`, `azure-pipelines.yml`, `.travis.yml`,
    `bitbucket-pipelines.yml`, `appveyor.yml`, `.drone.yml`) as root-scoped:
    only files at the repository root are recorded in `inventory.ci_files`.
    Nested copies (e.g. `vendor/Jenkinsfile`, `packages/foo/.travis.yml`) are
    not counted as CI.
  - Root-scoped workflow configs remain counted:
    `.github/workflows/*.yml` and `.github/workflows/*.yaml` at repository root
    continue to be recorded in `inventory.ci_files`.
  - Git-aware tracked-file precision is preserved: when tracked-file status is
    available, `inventory.ci_files` is filtered to tracked CI files only
    (untracked/ignored CI configs do not count) and existing `.lemma`/tracked
    behavior remains unchanged.
  - `StaticCheckRunner` / `static.ci` outcomes and evidence reflect the
    precisely scoped `ci_files` (actual lists scoped files only; no-CI finding
    when only nested CI-name configs exist). Behavior is covered by tests.
- **Verification:** `pnpm --filter @lemma/core test -- ci-root-scoping` (targeted file: `packages/core/test/ci-root-scoping/ci-root-scoping.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/static.ts` (`SourceInspector` root-scopes `CI_NAMES` discovery to repository-root files while preserving root `.github/workflows/*` detection and git-aware tracked CI filtering; `static.ci` reflects scoped `ci_files`), `packages/core/test/ci-root-scoping/ci-root-scoping.test.ts` (root vs nested CI_NAME configs, root workflows, nested-only no-CI outcome, and tracked-file CI precision). Test output: `docs/parity/evidence/LEM-035-ci-root-scoping-test-output.txt`. Commit/remote recorded in completion summary.


### LEM-033 — Port baseline category checks (test/functionality/browser/issues/demo/more)

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-014, LEM-027
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- category-checks`.
- **Description:** Port deterministic baseline static category scope checks for
  `test`, `functionality`, `browser`, `issues`, `demo`, and `more` intents.
- **Acceptance Criteria:**
  - Core static runner implements and dispatches `static.test_category`,
    `static.functionality_category`, `static.browser_category`,
    `static.issues_category`, `static.demo_category`, and `static.more_category`
    with assay-compatible evidence artifacts, payloads, actual strings, metadata,
    and passed outcomes (`test-category-scope`, `functionality-category-scope`,
    `browser-category-scope`, `issues-category-scope`, `demo-category-scope`,
    `more-category-scope`).
  - `issues` category scans code files for issue markers (`TODO/FIXME/HACK/XXX`)
    and records marker counts/files in payload/metadata/actual deterministically.
  - `demo` category inventories demo paths/directories, deterministic demo
    entrypoints (package scripts/Makefile targets), quickstart docs, and records
    `behavioral_evidence: false` with the no-URL limitation in payload/metadata/actual.
  - `more` category inventories extended surfaces (docs/examples/configs/scripts,
    CI/manifests) with deterministic limits/sorting and assay-compatible counts in
    payload/metadata/actual; supporting constants/helpers and exports are added to
    `@lemma/core` as needed with tests covering all six checks.
- **Verification:** `pnpm --filter @lemma/core test -- category-checks` (targeted file: `packages/core/test/category-checks/category-checks.test.ts`) — **PASS** (5 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/static.ts` (`StaticCheckRunner` dispatch/methods and constants/helpers for `static.test_category`, `static.functionality_category`, `static.browser_category`, `static.issues_category`, `static.demo_category`, `static.more_category` with assay-compatible evidence names/descriptions/payloads, actuals, metadata, issue-marker/demo/more inventory behavior), exported via `@lemma/core`; `packages/core/test/category-checks/category-checks.test.ts` (all six category checks). Test output: `docs/parity/evidence/LEM-033-category-checks-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-032 — Port unsafe-code rules

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-027
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- unsafe-scan`.
- **Description:** Port deterministic unsafe-code pattern scanning (`static.unsafe`)
  with assay-compatible rules, precision, and evidence/findings.
- **Acceptance Criteria:**
  - Core static runner implements `static.unsafe` scanning `CODE_EXTENSIONS`
    source files with assay-compatible `UNSAFE_RULES` (eval/exec precision, child
    process exec, shell=true, os.system, innerHTML/dangerous HTML, TLS/crypto
    misconfig, CORS wildcard, debug, etc.), scan limits, line-by-line matching,
    30-match cap, and test-path severity downgrade.
  - Evidence artifact `unsafe-pattern-scan` is saved with kind `static_analysis`
    and description `High-risk source pattern matches.`; payload contains
    `matches` (rule/severity/file/line/excerpt trimmed to 180 chars).
  - Outcomes are assay-compatible: no matches => passed, actual
    `No high-risk source patterns matched.`, metadata `{matches: 0}`; with
    matches => failed, actual `${count} high-risk source pattern match(es) found.`,
    metadata `{matches: count}`, and grouped findings (up to 8 by rule+file) with
    rule title/count/location (`file:line`), downgraded severity, domain
    `security`, rule consequence/remediation/verification, reproduction
    `Inspect the cited line and trace whether untrusted input can reach it.`,
    and tags `["unsafe-pattern", <rule_id>]`.
  - `UNSAFE_RULES` and runner support are exported from `@lemma/core` as needed
    with tests covering no-match pass, representative rule matches/grouping, and
    precision (e.g. member `.exec()` calls not treated as bare eval/exec).
- **Verification:** `pnpm --filter @lemma/core test -- unsafe-scan` (targeted file: `packages/core/test/unsafe-scan/unsafe-scan.test.ts`) — **PASS** (4 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/static.ts` (`UNSAFE_RULES`, and `StaticCheckRunner.checkStaticUnsafe`/`static.unsafe` dispatch with assay-compatible `unsafe-pattern-scan` evidence, 30-match cap, grouping, precision rules, and findings), exported via `@lemma/core`; `packages/core/test/unsafe-scan/unsafe-scan.test.ts` (clean pass, representative matches/grouping, member-exec precision vs bare/child_process exec, and test-path severity downgrade). Test output: `docs/parity/evidence/LEM-032-unsafe-scan-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-031 — Port secret scanning and precision rules

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-027
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- secret-scan`.
- **Description:** Port deterministic secret scanning (`static.secrets`) with
  redaction and precision rules to avoid obvious placeholder/test-fixture noise.
- **Acceptance Criteria:**
  - Core static runner implements `static.secrets` scanning source files with
    assay-compatible `SECRET_RULES` (including `private-key`, provider tokens,
    JWT, and `generic-credential`), file/scan limits, line-by-line matching, and
    a 25-match cap; `generic-credential` evaluates the captured value with
    placeholder/test-credential-fixture/entropy filters (ignored count tracked),
    private keys use header redaction, and other matches redact the matched value.
  - Precision/redaction helpers are ported: entropy calculation, placeholder
    detection, synthetic test-credential fixture allowlist (test paths only),
    `redact()` formatting, and test-path severity downgrade behavior.
  - Evidence artifact `secret-scan` is saved with kind `static_analysis` and
    description `Redacted secret scan results.`; payload contains `matches`,
    `ignored_placeholder_or_test_fixture_matches`, and
    `note: "Values are redacted; length and prefix only."`. Outcomes are
    assay-compatible for pass/fail actuals and metadata.
  - Matches are grouped (up to 8 by rule+file) into security findings with
    correct title/count/location (`file:line`), downgraded severity, rule
    consequence/remediation/verification, reproduction
    `Inspect the redacted match in the evidence file and confirm whether the value is live.`,
    and tags `["secret", "redacted"]`; APIs exported from `@lemma/core` with tests
    covering redaction, ignored fixtures/placeholders, real-looking secrets, and caps/grouping.
- **Verification:** `pnpm --filter @lemma/core test -- secret-scan` (targeted file: `packages/core/test/secret-scan/secret-scan.test.ts`) — **PASS** (5 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/static.ts` (`SECRET_RULES`, entropy/placeholder/test-fixture/redaction helpers, and `StaticCheckRunner.checkStaticSecrets`/`static.secrets` dispatch with assay-compatible `secret-scan` evidence, precision filtering, redaction, grouping, and findings), exported via `@lemma/core`; `packages/core/test/secret-scan/secret-scan.test.ts` (clean pass, real-secret redaction/grouping, placeholder/fixture precision+ignored counts, private-key header redaction/test-path downgrade, provider token redaction). Test output: `docs/parity/evidence/LEM-031-secret-scan-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-030 — Port the accessibility markup scan

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-027
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- accessibility-scan`.
- **Description:** Port deterministic source-level accessibility markup heuristics
  (`static.accessibility`) with assay-compatible evidence and findings.
- **Acceptance Criteria:**
  - Core static runner implements `static.accessibility` scanning markup files from
    inventory (`MARKUP_EXTENSIONS`) with assay-compatible constraints (skip missing,
    `.min.` names, files over `MAX_SCAN_BYTES`, binary/unreadable content, and cap at
    `MAX_SCAN_FILES`), evaluating the ported `A11Y_RULES` line-by-line with test-path
    severity downgrades and match collection capped at 30.
  - Evidence artifact `source-accessibility-scan` is saved with kind `static_analysis`
    and description `Static accessibility heuristics on markup and component templates.`,
    payload containing `matches` and `files_scanned` (inventory `markup_files`).
  - Outcomes are assay-compatible: no matches => passed, actual
    `No obvious source-level accessibility barriers matched.`, metadata
    `{matches: 0}`; with matches => failed, actual
    `${matches} source-level accessibility match(es) across ${markup_files.length} markup file(s).`,
    grouped findings (up to 8 by rule+file) with rule title/count/location
    (`file:line`), downgraded severity, domain `accessibility`, rule
    consequence/remediation/verification, reproduction
    `Inspect the cited markup and verify the rendered accessibility tree.`,
    and tags `["accessibility", <rule_id>]`.
  - APIs/rules/helpers are exported from `@lemma/core` as needed and tests cover
    clean markup, rule matches/grouping/limits, and test-path severity downgrade.
- **Verification:** `pnpm --filter @lemma/core test -- accessibility-scan` (targeted file: `packages/core/test/accessibility-scan/accessibility-scan.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/static.ts` (`A11Y_RULES`, test-path severity downgrade, markup-file iteration/read helpers, and `StaticCheckRunner.checkStaticAccessibility`/`static.accessibility` dispatch with assay-compatible `source-accessibility-scan` evidence, outcomes, grouping, and findings), exported via `@lemma/core`; `packages/core/test/accessibility-scan/accessibility-scan.test.ts` (clean pass case, grouped rule matches/payload, and test-path severity downgrade). Test output: `docs/parity/evidence/LEM-030-accessibility-scan-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-029 — Port inventory, tests, CI, and dependency checks

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-014, LEM-027
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- static-checks`.
- **Description:** Port static analysis checks for repository inventory, automated
  test signal, CI configuration, and dependency/environment hygiene with
  assay-compatible evidence and findings.
- **Acceptance Criteria:**
  - Core exposes a static check runner (e.g. `StaticCheckRunner`) for `InventoryData`
    + `EvidenceStore` that executes `static.inventory`, `static.tests`, `static.ci`,
    and `static.dependencies`, saving evidence artifacts with kind `static_analysis`
    and assay-compatible names/descriptions (`source-inventory`, `test-inventory`,
    `ci-inventory`, `dependency-and-env-inventory`), and returning `CheckOutcome`
    with correct status/actual/evidence/metadata.
  - `static.inventory`: persists full inventory payload, reports actual as
    `${total_files} files, ${total_bytes} bytes; languages: ${sorted or "none"};
    manifests: ${count}; tests: ${count}; CI: ${count}` and includes inventory in
    metadata; passes when inventory is produced.
  - `static.tests`: persists `{test_files,test_frameworks}`, reports actual as
    `${count} test file(s) found; frameworks: ${joined or "not detected"}`; when no
    test files adds a MEDIUM/functional/source-proven coverage-gap finding with
    assay-compatible title/consequence/location/reproduction/remediation/verification/tags.
  - `static.ci`: persists `{ci_files}`, reports actual as `CI files: ${joined or "none"}`;
    when no CI config adds a LOW/reliability coverage-gap finding with
    assay-compatible fields.
  - `static.dependencies`: computes reported committed env files from tracked
    availability, persists dependency/env payload including tracked/ignored fields,
    reports actual/metadata per tracked semantics, adds HIGH/data_integrity findings
    for first 3 reported env files and LOW/reproducibility finding when manifests
    exist without lockfiles (assay-compatible fields); APIs exported from
    `@lemma/core` with tests covering each check and git-aware env reporting.
- **Verification:** `pnpm --filter @lemma/core test -- static-checks` (targeted file: `packages/core/test/static-checks/static-checks.test.ts`) — **PASS** (6 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/static.ts` (`StaticCheckRunner`/`StaticCheckLike` executing `static.inventory`, `static.tests`, `static.ci`, `static.dependencies` with assay-compatible evidence artifacts, actual/metadata, and findings including git-aware dependency/env reporting), exported via `@lemma/core`; `packages/core/test/static-checks/static-checks.test.ts` (inventory/tests/CI/dependencies outcomes and evidence, missing-signal findings, and git tracked/ignored env reporting). Test output: `docs/parity/evidence/LEM-029-static-checks-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-028 — Port `.harnessignore`-equivalent scoping

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-027
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- harnessignore`.
- **Description:** Port target-root ignore scoping equivalent to assay
  `.harnessignore` for deterministic first-party/vendored inventory boundaries.
- **Acceptance Criteria:**
  - `SourceInspector` resolves scoping from target root using `.lemmaignore` as
    the canonical file and `.harnessignore` as an accepted equivalent alias
    (fallback/compatibility when canonical file absent, and/or explicit override),
    with deterministic precedence and recorded `excluded_patterns`.
  - Ignore file semantics match assay parity: gitignore-style path patterns,
    `#` comments/blank-line skipping, `!` re-inclusion (including descendant
    re-inclusion under excluded directories), and directory/file matching that
    excludes matched paths from inventory/source lists while preserving
    auditable `excluded_paths` and `excluded_file_count`.
  - Explicit ignore-file overrides are supported by core API for deterministic
    scoping; traversal behavior remains consistent with negations (do not prune
    descendants when negations may re-include).
  - Tests cover `.lemmaignore` canonical behavior, `.harnessignore` alias
    compatibility/precedence, vendored-path exclusion, negation re-inclusion of a
    descendant, and inventory exclusion metadata.
- **Verification:** `pnpm --filter @lemma/core test -- harnessignore` (targeted file: `packages/core/test/harnessignore/harnessignore.test.ts`) — **PASS** (4 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/static.ts` (canonical `.lemmaignore` with `.harnessignore` fallback alias, deterministic precedence/explicit ignore-file overrides, recorded `excluded_patterns`, negation-aware traversal for descendant re-inclusion), `packages/core/test/harnessignore/harnessignore.test.ts` (`.lemmaignore` canonical vendored exclusion + negation, `.harnessignore` alias compatibility, canonical-over-alias precedence, explicit override scoping). Test output: `docs/parity/evidence/LEM-028-harnessignore-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-027 — Port source inventory and git-aware tracked/ignored scanning

- **Epic:** E3 Evidence Checks and Personas
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-013
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- inventory`.
- **Description:** Port deterministic source inventory discovery and git-aware
  tracked/ignored classification for repository scanning.
- **Acceptance Criteria:**
  - `Inventory`/`SourceInspector` (or equivalent core APIs) discover repository
    files deterministically: walk with sorted traversal, skip built-in ignored
    directories/hidden dirs (except `.github`/`.circleci`), respect ignore-file
    scoping patterns (`.lemmaignore` equivalent to assay `.harnessignore`,
    including negations and directory/file pattern matching), and record
    `excluded_paths`/`excluded_file_count`/`excluded_patterns` and `skipped_dirs`.
  - Inventory classifies files and metadata: `files`, `source_files`,
    `markup_files`, `manifests`, `test_files`, `ci_files`, `lockfiles`,
    `env_files`, `languages`, `total_files`/`total_bytes`, truncation flags/limits
    (`MAX_*` parity), and derived booleans/summary fields compatible with assay
    inventory shape.
  - Git-aware scanning uses `git ls-files -z` when available to set
    `tracked_available`/`tracked_file_count`, split `env_files_tracked` vs
    `env_files_ignored`, and filter `ci_files` to tracked files; non-git targets
    fall back to filesystem-only inventory without tracked claims.
  - Test framework detection is derived from manifests/test file hints, and
    APIs/types are exported from `@lemma/core` with tests covering filesystem
    discovery, ignore/exclusion behavior, git-tracked classification, and
    deterministic ordering/limits.
- **Verification:** `pnpm --filter @lemma/core test -- inventory` (targeted file: `packages/core/test/inventory/inventory.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/static.ts` (`SourceInspector`/`InventoryData` discovery with sorted deterministic traversal, skip/exclude handling via `.lemmaignore`/`.harnessignore` patterns including negations, classification/limits/summary flags, git-aware `ls-files -z` tracked/env/CI classification, framework detection; exported from `@lemma/core`), `packages/core/test/inventory/inventory.test.ts` (filesystem discovery/classification, ignore+negation scoping, git tracked/ignored env and tracked-only CI). Test output: `docs/parity/evidence/LEM-027-inventory-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-026 — Build the orchestrator conformance suite

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-015, LEM-016, LEM-018, LEM-020, LEM-021
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- conformance`.
- **Description:** Build a core orchestrator conformance/integration suite that
  validates deterministic end-to-end engine behavior across phase control, kill,
  resume/crash safety, evidence, scoring, and reporting.
- **Acceptance Criteria:**
  - Suite exercises full deterministic orchestration with seeded/injected options
    and injectable handlers, asserting fixed five-phase order/invariants, run/
    phase/check transitions, budget enforcement, and progress/events/history
    persistence in `StateStore`.
  - Integrated completion flow produces hashed evidence artifacts with checkpoint
    and finalized manifest/verification pass, computes confidence via
    `scoreConfidence`, and builds a schema-valid `quality-harness.report/v1`
    report via `buildReport` consistent with run state (status/decision/
    confidence/coverage/evidence/timestamps/registry fingerprint metadata).
  - Kill/halt conformance: requested or handler-triggered halt stops execution,
    skips remaining phases/checks, persists halted status/reason and history, and
    resulting confidence/report reflect hold/halted semantics with no automatic
    resume.
  - Resume/crash-safety conformance: simulated crash/incomplete run resumes to
    completion rerunning only unfinished checks while preserving completed
    evidence refs/findings/blockers and registry fingerprint; resumed run
    finalizes/verifies evidence and yields a schema-valid report.
  - Conformance tests live in core (e.g. `packages/core/test/conformance/**`)
    with tracked evidence output and pass as the stated acceptance test.
- **Verification:** `pnpm --filter @lemma/core test -- conformance` (targeted file: `packages/core/test/conformance/orchestrator-conformance.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/test/conformance/orchestrator-conformance.test.ts` (deterministic full-flow phase/state/events/history/budget + verified checkpointed/finalized evidence + `scoreConfidence` + schema-valid `buildReport`; handler-triggered halt/skip/hold semantics with no auto-resume; crash-resume rerun-only-unfinished with preserved evidence refs/findings/blockers/fingerprint and finalized verified schema-valid report). Test output: `docs/parity/evidence/LEM-026-conformance-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-025 — Port the scenario step planner and runner

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P1
- **Points:** 5
- **Depends on:** LEM-024
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- steps`.
- **Description:** Port scenario step planning and core execution/result
  evaluation contracts for natural-language ticket scenarios.
- **Acceptance Criteria:**
  - Core exposes scenario step models and planner APIs: `StepAction`,
    `ScenarioPlan`, `StepPlanner`, deterministic `HeuristicStepPlanner`, and
    `LLMStepPlanner`/`createStepPlanner` with LLM-compatible compilation and safe
    fallback to heuristic parsing (no non-stdlib runtime deps in core).
  - Heuristic planner parses numbered/bulleted/prose instructions into structured
    actions (goto/click/fill/toggle/assertions including no-errors/plan-cards/text
    variants and fallbacks) with normalized targets/values and base-URL
    resolution for navigation.
  - Core exposes scenario execution result contracts and check evaluation:
    `StepResult`, `ScenarioExecutionResult`, and `evaluateScenarioCheck(...)`
    producing pass/fail/blocked outcomes, evidence refs, counts/metadata, and
    deterministic finding details for failed scenarios (Playwright/browser driving
    remains outside core).
  - APIs/types exported from `@lemma/core` with tests covering heuristic
    compilation cases, LLM planner parse/fallback behavior (mocked transport),
    and scenario-check evaluation outcomes.
- **Verification:** `pnpm --filter @lemma/core test -- steps` (targeted file: `packages/core/test/steps/steps.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/steps.ts` (`StepAction`/`ScenarioPlan`, `HeuristicStepPlanner`, `LLMStepPlanner`/`createStepPlanner` with OpenAI-compatible fetch+fallback, `StepResult`/`ScenarioExecutionResult`, `evaluateScenarioCheck`; exported from `@lemma/core`), `packages/core/test/steps/steps.test.ts` (heuristic compilation/base-URL resolution, LLM parse/fallback and factory, execution-result evaluation outcomes). Test output: `docs/parity/evidence/LEM-025-steps-test-output.txt`. Commit/remote recorded in completion summary. Note: Playwright page-driving scenario execution remains in browser integration (outside core).

### LEM-024 — Port risk analysis

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-013
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- risk`.
- **Description:** Port deterministic risk ranking from intent, target shape, and
  inventory signals to produce prioritized `Risk` records.
- **Acceptance Criteria:**
  - `RiskAnalyzer` (or equivalent core API) ranks risks from intent, target, and
    inventory: baseline outcome/scope risks, target-kind risks (live URL vs
    source-only when browser not planned), intent-keyword-driven risks, and
    inventory-driven risks (no tests, no CI, tracked/committed env files,
    manifests without lockfiles, markup/accessibility exposure).
  - Risks include stable fields (`id` numbered `risk-NN` after dedupe, title,
    priority/severity-aligned priority, domain, consequence, evidence,
    weight_multiplier, source/status as applicable) and are deduped by normalized
    title and capped to 12 in deterministic order.
  - Intent and inventory matching follow assay parity for supported rules and
    committed-env handling (`tracked_available`/`env_files_tracked` preferred),
    using deterministic inputs only.
  - API/types exported from `@lemma/core` with tests covering intent keyword
    matching, target/inventory-driven risks, dedupe/numbering/cap, and weight
    multipliers/evidence.
- **Verification:** `pnpm --filter @lemma/core test -- risk` (targeted file: `packages/core/test/risk/risk.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/risk.ts` (`RiskAnalyzer`, `analyzeRisk`, `INTENT_RULES`, `PRIORITY_MULTIPLIER`, inventory-aware risk ranking with dedupe/numbering/cap and tracked-env handling; exported from `@lemma/core`), `packages/core/test/risk/risk.test.ts` (intent/target/inventory risks, evidence/multipliers, tracked-env preference, dedupe/numbering/cap). Test output: `docs/parity/evidence/LEM-024-risk-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-023 — Port run history, retention, and prune

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P2
- **Points:** 3
- **Depends on:** LEM-011
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- history`.
- **Description:** Port run history recording, retention/prune behavior, and
  evidence-safe history maintenance in `StateStore`.
- **Acceptance Criteria:**
  - `StateStore.recordRun`/`loadHistory` maintain a versioned, deterministically
    sorted (newest-first) history with upsert-by-run-id and enriched entries
    (status, decision, score, workflow/target metadata, timestamps/evidence path,
    finding_counts by severity, and sorted finding_fingerprints when available).
  - `StateStore.prune` supports `keepRuns`, `olderThanDays`, `dryRun`, and `now`;
    protects latest run, latest completed run, and all halted runs; writes updated
    history index before deleting evidence; removes only evidence under
    `.lemma/evidence`; and never mutates state on dry-run.
  - Invalid prune options/timestamps and unsafe evidence paths produce typed
    `StateError`s; missing evidence paths are handled safely.
  - Tests cover history recording/enrichment/sorting/upsert, keep-runs and
    older-than retention with protections, dry-run non-mutation, and safe
    evidence-prune behavior.
- **Verification:** `pnpm --filter @lemma/core test -- history` (targeted file: `packages/core/test/history/history.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core test -- state/store` (`packages/core/test/state/state-store.test.ts`) — **PASS** (5 tests, regression). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/state-store.ts` (enriched history entries with derived decision/score, `finding_counts`, sorted `finding_fingerprints`, workflow/target/evidence metadata; retention/prune protections, dry-run, index-before-delete, safe `.lemma/evidence` removal), `packages/core/test/history/history.test.ts`, `docs/parity/evidence/LEM-023-history-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-022 — Port seeded resume and id-sequence continuity

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P2
- **Points:** 3
- **Depends on:** LEM-006, LEM-021
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- seeded-resume`.
- **Description:** Port seeded determinism continuity across resume so run/finding
  IDs remain stable and sequence counters continue from saved state.
- **Acceptance Criteria:**
  - Seeded runs record determinism and sequence state in progress/options
    (`seed`, `clock_mode`, `frozen_clock` when applicable, `id_sequence` and/or
    `entropy_counter`) and surface it in persisted run state.
  - On `resume`, orchestrator restores saved determinism options (seed/clock mode/
    frozen clock) and continues the seeded ID/entropy sequence from saved counter,
    even if caller provides different determinism options.
  - Simulated crash + seeded resume produces the same run identity and generated
    finding/check IDs as an uninterrupted seeded run for equivalent execution; a
    resumed completed seeded run does not rewrite existing IDs/evidence artifacts.
  - APIs/types updated as needed and tests cover sequence persistence, restore-on-
    resume precedence, and continuity/stability.
- **Verification:** `pnpm --filter @lemma/core test -- seeded-resume` (targeted file: `packages/core/test/seeded-resume/seeded-resume.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/determinism.ts` (`entropyCounter` helper), `packages/core/src/orchestrator.ts` (seeded determinism context setup/restore, sequence persistence in state/options, saved-determinism precedence and counter continuation on resume), `packages/core/test/seeded-resume/seeded-resume.test.ts` (sequence persistence, saved-options precedence/continuity, crash+resume ID parity and completed-run stability). Test output: `docs/parity/evidence/LEM-022-seeded-resume-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-021 — Port resume, crash safety, and registry fingerprint

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-011, LEM-015
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- resume`.
- **Description:** Port deterministic resume and crash-safety behavior, including
  registry/workflow/target guards and evidence/checkpoint reconciliation.
- **Acceptance Criteria:**
  - `StateStore`/run state persist and expose registry fingerprint metadata
    (`options.registry_fingerprint` and `options.plugin_registry_fingerprint`)
    for runs so resumes can detect check-registry drift.
  - `Orchestrator` supports `resume` mode: loads existing progress, rejects resume
    with actionable `StateError` when run is halted, target does not match, saved
    workflow version differs from current, or saved registry fingerprint differs
    from current; failed guards do not mutate saved progress/evidence.
  - Crash-safe resume preparation resets incomplete phases appropriately, reruns
    only unfinished checks (`planned`/`running`/`error`) while preserving
    completed check outcomes/evidence refs/findings/blockers for completed checks,
    rebuilds contract-failure state for retained invalid findings, and clears run
    error/halted/completion markers for continued execution.
  - Evidence reconciliation/checkpointing integrates with resume: before resuming
    incomplete execution, orchestrator reconciles evidence manifest with
    checkpointed check state (dropping/rerun-owned entries and recovering
    referenced completed artifacts as needed) and persists updated state
    atomically.
  - Core APIs are exported/tested for resume success after simulated crash,
    target-mismatch rejection, and registry-fingerprint change/removal rejection
    without evidence/progress mutation.
- **Verification:** `pnpm --filter @lemma/core test -- resume` (targeted file: `packages/core/test/resume/resume.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/orchestrator.ts` (resume mode/guards, crash-safe preparation, rerun-only-unfinished semantics, evidence reconciliation integration, fingerprint persistence), `packages/core/src/checks.ts` (`registryFingerprint`), `packages/core/test/resume/resume.test.ts` (fingerprint persistence, crash-resume preservation/rerun, target/fingerprint mismatch guards without progress/evidence mutation). Test output: `docs/parity/evidence/LEM-021-resume-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-020 — Port the report builder and JSON Schema validation

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-013, LEM-018
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- report`.
- **Description:** Port the `quality-harness.report/v1` builder and schema
  validation so runs produce deterministic, assay-compatible JSON reports.
- **Acceptance Criteria:**
  - `buildReport(state, workflow, evidenceSummary, generatedAt?)` emits
    `quality-harness.report/v1` with assay-compatible structure: determinism,
    status/workflow/target/intent/policy/metering/decision/trend/confidence,
    sorted findings/blockers/invalid_findings, finding_counts, checks, coverage,
    risks/personas/inventory/phases/kill_switch, limitations, evidence, timestamps,
    options, error, and contract_failures summary.
  - Coverage and decision logic match assay semantics (counts by status/domain,
    blockers/uncovered, executed_pct; hold for halted/failed, ship/review/hold by
    gate status) and normalized defaults for metering/policy/trend/personas.
  - Published report JSON Schema and `reportSchema()` reflect the report contract;
    `validateReport`/`isValidReport` perform schema validation (dependency-free)
    and return errors for invalid reports.
  - Report APIs/types are exported from `@lemma/core` with tests covering report
    structure/decision/coverage/sorting/limitations and schema validation
    acceptance/rejection.
- **Verification:** `pnpm --filter @lemma/core test -- report` (targeted file: `packages/core/test/report/report.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/report.ts` (`buildReport`, `coverage`, `decisionForState`, `reportSchema`/`reportSchemaPath`, dependency-free `validateReport`/`isValidReport`, exported from `@lemma/core`), `schemas/report/report.v1.schema.json` and `packages/core/src/schemas/report.ts` aligned to assay-compatible `quality-harness.report/v1` contract, `packages/core/test/report/report.test.ts` (structure/decision/coverage/sorting/limitations and schema validation acceptance/rejection/additive). Test output: `docs/parity/evidence/LEM-020-report-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-019 — Port versioned policy files and gate evaluation

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-018
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- policy`.
- **Description:** Port the versioned policy contract/file (advisory-v1) and
  gate-evaluation behavior used by scoring/reporting.
- **Acceptance Criteria:**
  - Canonical default policy file `policies/advisory-v1.json` exists with schema
    `quality-harness.policy/v1`, id `advisory-v1`, version `1.0`, and default
    weights/penalties/scope factors/caps/gate thresholds matching assay.
  - `loadPolicy`/`policyFromDict` validate versioned policy files: require correct
    schema version, reject unknown fields, reject invalid values/ordering (e.g.
    empty domain weights, invalid ranges, critical cap exceeding two-high cap),
    and allow omitted sections/fields to default (partial policies).
  - Gate evaluation semantics are exposed/verified via scoring policy behavior:
    pass/warn/fail status and reasons reflect score, coverage thresholds, and
    critical/high-finding settings per loaded policy (including custom policies).
  - APIs/types are exported from `@lemma/core` and tests cover default policy
    reproduction, partial/relaxed policy loading, invalid-policy rejection, and
    gate-evaluation outcomes for custom thresholds.
- **Verification:** `pnpm --filter @lemma/core test -- policy` (targeted file: `packages/core/test/policy/policy.test.ts`) — **PASS** (4 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `policies/advisory-v1.json` (canonical versioned default policy), `packages/core/src/scoring.ts` policy model/validation/load/defaulting and gate evaluation semantics (exported from `@lemma/core`), `packages/core/test/policy/policy.test.ts` (default policy reproduction, partial/relaxed loading, invalid-policy rejection, custom gate-evaluation outcomes). Test output: `docs/parity/evidence/LEM-019-policy-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-018 — Port `weighted-coverage-v1` scoring

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-013
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- scoring`.
- **Description:** Port assay's explainable `weighted-coverage-v1` confidence
  scoring (coverage/quality/scope factors, severity penalties, caps, bands,
  limitations/rationale/breakdown/domain scores, and gate evaluation).
- **Acceptance Criteria:**
  - `FORMULA_VERSION` is `weighted-coverage-v1` with default domain weights,
    severity penalties, scope factors, caps, and gate thresholds matching assay.
  - `scoreConfidence` (or equivalent) computes weighted executed/passed coverage
    and quality, applies scope and coverage factors, deduplicates findings by
    fingerprint, applies severity penalties (suspected halved, capped), enforces
    score caps (critical, two-high, halted), clamps/bands score, and produces
    domain scores, penalties, breakdown, rationale, and limitations.
  - Gate evaluation returns pass/warn/fail with reasons based on score,
    coverage, and critical/high findings per policy; halted/blocked/failed-without-finding
    cases add appropriate limitations and behavior.
  - Policy model supports defaults and validation/overrides used by scoring (and
    basic load/parse if included) with typed errors; APIs/types exported from
    `@lemma/core`.
  - Tests cover formula/band/cap behavior, dedupe/suppressed/suspected penalties,
    scope/coverage gaps, domain scoring/breakdown/rationale/limitations, and gate
    outcomes for representative cases.
- **Verification:** `pnpm --filter @lemma/core test -- scoring` (targeted file: `packages/core/test/scoring/scoring.test.ts`) — **PASS** (4 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14). Supporting fixes included: `Confidence.penalties` normalization preserved as structured record (models/test updated) and deterministic-clock fix in `evidence-signing` test.
- **Evidence:** `packages/core/src/scoring.ts` (`FORMULA_VERSION` `weighted-coverage-v1`, default weights/penalties/scope/caps/gates, `scoreConfidence` with coverage/quality/scope factors, fingerprint dedupe, severity penalties with suspected halving/cap, score caps/banding, domain scores/breakdown/rationale/limitations, and policy/gate evaluation; policy defaults/validation/load helpers), exported from `@lemma/core`; `packages/core/test/scoring/scoring.test.ts` (no-checks, formula/caps/breakdown/domain/limitations, dedupe/suppressed/suspected/caps/gate, policy validation/gate outcomes). Test output: `docs/parity/evidence/LEM-018-scoring-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-017 — Port evidence signing, verification, and tamper hold

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-016
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- evidence-signing`.
- **Description:** Port deterministic evidence manifest signing (HMAC-SHA256),
  verification, and tamper detection/hold signaling for the evidence store.
- **Acceptance Criteria:**
  - `EvidenceStore` signs checkpoint and final manifests with HMAC-SHA256 over
    canonical payload (excluding `signature`, `signature_algorithm`, `signed_at`)
    and records `signature_algorithm`, `signed_at`, and `signature`.
  - Default signing key is deterministic per run id (portable across runs with
    same run id); callers can inject a key (bytes/string/file path contents).
  - `verify()` re-hashes artifacts against manifest entries, verifies manifest
    signature, and reports missing/mismatched artifacts and signature errors with
    affected items and `tampered`/alert status suitable for hold-on-tamper.
  - Verification prefers persisted manifest entries and handles missing/unreadable
    manifests; APIs exported from `@lemma/core`.
  - Tests cover deterministic signing, signature verification, tamper detection
    (artifact modification, missing artifact, signature/manifest tamper), and
    clean verification results.
- **Verification:** `pnpm --filter @lemma/core test -- evidence-signing` (targeted file: `packages/core/test/evidence/evidence-signing.test.ts`) — **PASS** (3 tests). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/evidence.ts` (deterministic per-run HMAC-SHA256 manifest signing with injectable key, signed checkpoint/final manifests, and `verify()` re-hashing artifacts/verifying signatures with missing/mismatch/signature-error affected reporting and `tampered`/alert hold signal), exported from `@lemma/core`; `packages/core/test/evidence/evidence-signing.test.ts` (deterministic signing/clean verification, artifact/missing/manifest-signature tamper detection, injected key and missing/unreadable manifest cases). Test output: `docs/parity/evidence/LEM-017-evidence-signing-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-016 — Port the hashed evidence store and checkpoint manifest

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-010
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- evidence`.
- **Description:** Port the per-run hashed evidence artifact store and atomic
  checkpoint/final manifest primitives under `.lemma/evidence/<run_id>/`.
- **Acceptance Criteria:**
  - `EvidenceStore` (or equivalent core API) writes artifacts under
    `.lemma/evidence/<run_id>/` with project-root-relative portable paths and
    records entries containing path, kind, description, check_id, bytes, sha256,
    content_type, and created_at (deduped by path for replaced artifacts).
  - Store supports saving text/JSON/bytes/screenshot/console-log/network-log
    artifacts with stable slugged naming and collision-safe suffixing.
  - `checkpoint()` atomically persists a provisional manifest (including
    `checkpoint: true`, evidence list, summary) after updates; `reconcile(checks)`
    aligns loaded entries with checkpointed check state (drop rerun-check entries
    and recover on-disk artifacts referenced by completed checks when missing
    from manifest).
  - `finalize(runMetadata)` writes the final manifest (run metadata/summary) and
    returns manifest details including manifest path/hash; `summary()` reports
    directory, count, by_kind, total_bytes, and manifest path.
  - Hashing/IO uses shared primitives/safe paths (no evidence outside run dir/root
    traversal), APIs exported from `@lemma/core`, with tests covering artifact
    storage/hashing, manifest checkpoint/reconcile/finalize/summary, and path
    safety/atomic behavior.
- **Verification:** `pnpm --filter @lemma/core test -- evidence` — **PASS** (4 tests; core suite 68/68 passed). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/evidence.ts` (`EvidenceStore` under `.lemma/evidence/<run_id>/` with portable relative paths, SHA-256/bytes/kind/content-type/check_id/created_at entries and path dedupe, save helpers for text/JSON/bytes/screenshot/console-log/network-log with slugged/collision-safe naming, atomic `checkpoint` manifests, `reconcile` to drop rerun-check entries and recover completed-check on-disk artifacts, `finalize` with run metadata/manifest path+hash, `summary`, and safe path handling), exported from `@lemma/core`; `packages/core/test/evidence/evidence.test.ts` (artifact storage/hashing/naming/summary, checkpoint, reconcile/recovery, finalize/manifest hash, path safety). Test output: `docs/parity/evidence/LEM-016-evidence-test-output.txt`. Commit/remote recorded in completion summary.

### LEM-015 — Port the five-phase orchestrator and budget

- **Epic:** E2 Deterministic Core Engine
- **Priority:** P0
- **Points:** 8
- **Depends on:** LEM-011, LEM-012, LEM-014
- **Status:** Done
- **Claimed:** 2026-11-14 — created acceptance criteria (board card); acceptance test: `pnpm --filter @lemma/core test -- orchestrator`.
- **Description:** Port the deterministic five-phase orchestration core
  (phase sequencing, state transitions/persistence, budget constraints, and
  kill-switch halting) as a core engine primitive with injectable phase handlers.
- **Acceptance Criteria:**
  - `Orchestrator` (or equivalent core API) runs phases in fixed workflow order
    (`risk_analysis` → `test_planning` → `execution` → `evidence_collection` →
    `confidence_scoring`) using workflow definitions and `StateStore`, creating/
    persisting `RunState` with phase/check/run status transitions and timestamps.
  - Budget/limits are enforced: run options honor `maxChecks` in planning inputs
    and orchestrator rejects invalid budget/options (e.g. non-positive max checks
    where applicable) with typed errors; phase handlers receive run context/options.
  - Kill switch semantics: orchestrator observes `StateStore` kill requests
    (before/around phases and at safe checkpoints) and when triggered marks kill
    state, halts execution, skips remaining phases/checks as appropriate, sets run
    status to `halted` with reason, persists state/events, and does not auto-resume.
  - Execution model is extensible: phase work is provided via injectable handlers
    (risk/planning/execution/evidence/confidence) so unported runners/scoring/
    evidence/report modules can be integrated by later tasks without changing the
    state machine contract.
  - APIs/types are exported from `@lemma/core` with tests covering phase order,
    persistence/state transitions, `maxChecks` budgeting behavior, kill-triggered
    halt/skip behavior, and invalid option/budget errors.
- **Verification:** `pnpm --filter @lemma/core test -- orchestrator` — **PASS** (4 tests; core suite 64/64 passed). `pnpm --filter @lemma/core typecheck` and `pnpm lint` passed (2026-11-14).
- **Evidence:** `packages/core/src/orchestrator.ts` (`Orchestrator` with fixed five-phase sequencing over workflow/`StateStore`, run/phase/check state transitions and timestamps, budget validation + `maxChecks` context, async kill-request observation/checkpoints with halt/skip semantics and halted run recording, injectable phase handlers for extensible integration), exported from `@lemma/core`; `packages/core/test/orchestrator/orchestrator.test.ts` (phase order/persistence/transitions, budget validation and handler budget, kill-triggered halt/skip/no-auto-resume, injectable handlers and failed-run recording). Test output: `docs/parity/evidence/LEM-015-orchestrator-test-output.txt`. Commit/remote recorded in completion summary.
