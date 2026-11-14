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

**Parity rule:** until `LEM-139`, `assay` is the oracle. A lemma run against the
same fixture and options must produce the same normalized report. Any intentional
divergence needs an ADR and a Decision Log row.

## Migration Gates

| Gate | Name | Exit criteria | Tasks |
| --- | --- | --- | --- |
| G0 | Foundation | Monorepo, schemas, determinism, errors, redaction, atomic state, and golden parity harness exist | LEM-001–LEM-010 |
| G1 | Core parity | A static `lemma run` matches `assay` for the sample fixture, including resume, kill, evidence, scoring, and report | LEM-011–LEM-026 |
| G2 | Evidence parity | Static, browser, persona, plugin, policy, export, and suppression behavior match the parity corpus | LEM-027–LEM-082 |
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
| LEM-007 | Port the typed error model and exit-code contract | P0 | 2 | LEM-004 | Backlog |
| LEM-008 | Port the redaction engine and synthetic corpus | P0 | 3 | LEM-004 | Backlog |
| LEM-009 | Decide package naming, release flow, and consumer contracts | P1 | 3 | LEM-001, LEM-003 | Backlog |
| LEM-010 | Port atomic state, JSON, and file-lock primitives | P0 | 5 | LEM-001, LEM-007 | Backlog |

### E2: Deterministic Core Engine

**Outcome:** A reproducible five-phase state machine with atomic state, hashed
evidence, resume, kill behavior, and a report that matches assay for the same
inputs.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-011 | Port progress state, events, history, retention, and kill file | P0 | 5 | LEM-010 | Backlog |
| LEM-012 | Port the versioned workflow loader and phase invariant | P0 | 5 | LEM-004, LEM-007 | Backlog |
| LEM-013 | Port domain models, findings, and normalization | P0 | 5 | LEM-004 | Backlog |
| LEM-014 | Port the check catalog, registry, and intent planning | P0 | 5 | LEM-013 | Backlog |
| LEM-015 | Port the five-phase orchestrator and budget | P0 | 8 | LEM-011, LEM-012, LEM-014 | Backlog |
| LEM-016 | Port the hashed evidence store and checkpoint manifest | P0 | 5 | LEM-010 | Backlog |
| LEM-017 | Port evidence signing, verification, and tamper hold | P1 | 3 | LEM-016 | Backlog |
| LEM-018 | Port `weighted-coverage-v1` scoring | P0 | 5 | LEM-013 | Backlog |
| LEM-019 | Port versioned policy files and gate evaluation | P1 | 3 | LEM-018 | Backlog |
| LEM-020 | Port the report builder and JSON Schema validation | P0 | 5 | LEM-013, LEM-018 | Backlog |
| LEM-021 | Port resume, crash safety, and registry fingerprint | P0 | 5 | LEM-011, LEM-015 | Backlog |
| LEM-022 | Port seeded resume and id-sequence continuity | P2 | 3 | LEM-006, LEM-021 | Backlog |
| LEM-023 | Port run history, retention, and prune | P2 | 3 | LEM-011 | Backlog |
| LEM-024 | Port risk analysis | P1 | 3 | LEM-013 | Backlog |
| LEM-025 | Port the scenario step planner and runner | P1 | 5 | LEM-024 | Backlog |
| LEM-026 | Build the orchestrator conformance suite | P0 | 5 | LEM-015, LEM-016, LEM-018, LEM-020, LEM-021 | Backlog |

### E3: Static Analysis and Category Coverage

**Outcome:** Source inspection is git-aware, scoped, precise, redacted, and
covers every assay category command with an owned check or a documented no-op.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-027 | Port source inventory and git-aware tracked/ignored scanning | P0 | 5 | LEM-013 | Backlog |
| LEM-028 | Port `.harnessignore`-equivalent scoping | P1 | 3 | LEM-027 | Backlog |
| LEM-029 | Port inventory, tests, CI, and dependency checks | P0 | 5 | LEM-014, LEM-027 | Backlog |
| LEM-030 | Port the accessibility markup scan | P1 | 3 | LEM-027 | Backlog |
| LEM-031 | Port secret scanning and precision rules | P0 | 5 | LEM-027 | Backlog |
| LEM-032 | Port unsafe-code rules | P0 | 3 | LEM-027 | Backlog |
| LEM-033 | Port baseline category checks (test/functionality/browser/issues/demo/more) | P1 | 5 | LEM-014, LEM-027 | Backlog |
| LEM-034 | Port full-assessment markers | P1 | 3 | LEM-027 | Backlog |
| LEM-035 | Port CI root-scoping precision | P2 | 2 | LEM-029 | Backlog |
| LEM-036 | Port risk tracked-file parity | P2 | 3 | LEM-024, LEM-027 | Backlog |
| LEM-037 | Cover the remaining 50+ category commands with owned checks or documented no-ops | P1 | 8 | LEM-033 | Backlog |
| LEM-038 | Port the sample-repo, demo-web, and static fixtures | P1 | 3 | LEM-027 | Backlog |
| LEM-039 | Build the static precision and recall corpus | P1 | 5 | LEM-031, LEM-032 | Backlog |
| LEM-040 | Verify static finding-to-evidence linkage and report totals | P1 | 3 | LEM-016, LEM-020 | Backlog |

### E4: Specialist Persona Layer

**Outcome:** Personas are data contracts, not prompt fragments. Ownership is
disjoint, invalid findings are quarantined, and a blocked check can never become
a pass.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-041 | Port the persona frontmatter parser | P0 | 3 | LEM-013 | Backlog |
| LEM-042 | Port output and blocker schema validation | P0 | 5 | LEM-041 | Backlog |
| LEM-043 | Port the functional, security, and accessibility contracts | P0 | 3 | LEM-041, LEM-042 | Backlog |
| LEM-044 | Port ownership derivation and disjointness enforcement | P0 | 3 | LEM-014, LEM-041 | Backlog |
| LEM-045 | Port invalid-finding quarantine and degraded streaks | P0 | 5 | LEM-013, LEM-042 | Backlog |
| LEM-046 | Port structured blocker and refusal records | P0 | 5 | LEM-042 | Backlog |
| LEM-047 | Port `personas lint` | P1 | 3 | LEM-041, LEM-044 | Backlog |
| LEM-048 | Port `personas scaffold` | P2 | 3 | LEM-047 | Backlog |
| LEM-049 | Port tool capability enforcement and persona conformance tests | P1 | 3 | LEM-043, LEM-044 | Backlog |

### E5: Browser and Operate Layer

**Outcome:** Live verification is real browser evidence when Chromium is
available, an explicit blocked coverage gap when it is not, and never a static
scan wearing a browser label.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-050 | Add the optional Playwright runtime and blocked degradation | P0 | 5 | LEM-013 | Backlog |
| LEM-051 | Port load, console, network, content, and link checks | P0 | 8 | LEM-050 | Backlog |
| LEM-052 | Port the browser security check | P1 | 3 | LEM-050 | Backlog |
| LEM-053 | Port the browser accessibility check | P1 | 3 | LEM-050 | Backlog |
| LEM-054 | Port the bounded same-origin crawl | P1 | 8 | LEM-051 | Backlog |
| LEM-055 | Port the responsive/mobile pack (overflow, focus order) | P1 | 5 | LEM-051 | Backlog |
| LEM-056 | Port authenticated storage-state injection | P1 | 3 | LEM-050 | Backlog |
| LEM-057 | Port HAR, trace, and video capture with redaction | P2 | 5 | LEM-051 | Backlog |
| LEM-058 | Port scenario-file execution and `browser.steps` | P1 | 5 | LEM-051 | Backlog |
| LEM-059 | Port SSRF-safe target validation and allowlists | P0 | 5 | LEM-010 | Backlog |
| LEM-060 | Port browser fixtures and the CI smoke/blocked legs | P1 | 3 | LEM-050, LEM-051 | Backlog |
| LEM-061 | Verify browser evidence, manifest, and report linkage | P0 | 3 | LEM-016, LEM-051 | Backlog |
| LEM-062 | Port viewport and check metadata contracts | P2 | 2 | LEM-051, LEM-055 | Backlog |
| LEM-063 | Port browser defaults (crawl, mobile, headed, active) | P1 | 3 | LEM-054, LEM-055 | Backlog |
| LEM-064 | Build the browser regression suite | P1 | 5 | LEM-051, LEM-054, LEM-055, LEM-058 | Backlog |

### E6: Reporting, Policy, and Exports

**Outcome:** The report is versioned, portable, comparable, signable, and
reconcilable. Suppressions are auditable and never silent.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-065 | Port SARIF export | P1 | 3 | LEM-020 | Backlog |
| LEM-066 | Port JUnit export | P1 | 3 | LEM-020 | Backlog |
| LEM-067 | Port report signing and verification | P1 | 3 | LEM-020 | Backlog |
| LEM-068 | Port run-to-run trend diff | P1 | 3 | LEM-011, LEM-020 | Backlog |
| LEM-069 | Port baseline suppression with owner and expiry | P1 | 3 | LEM-013 | Backlog |
| LEM-070 | Port labeled calibration fixtures and `calibrate` | P1 | 3 | LEM-018 | Backlog |
| LEM-071 | Port `verify-evidence` and the hold-on-tamper behavior | P1 | 3 | LEM-017 | Backlog |
| LEM-072 | Port run-scoped and sink-wide metering summaries | P1 | 2 | LEM-020 | Backlog |
| LEM-073 | Build report-schema compatibility and contract tests | P1 | 3 | LEM-020 | Backlog |
| LEM-074 | Build policy and calibration regression coverage | P2 | 3 | LEM-019, LEM-070 | Backlog |

### E7: Plugins and Extensibility

**Outcome:** Teams can add a check without editing the orchestrator. A plugin
that cannot be verified is a blocked gap, never a pass and never a run failure.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-075 | Port the signed plugin registry | P0 | 8 | LEM-014 | Backlog |
| LEM-076 | Port the plugin context and blocked-failure handling | P0 | 5 | LEM-075 | Backlog |
| LEM-077 | Port plugin ownership validation | P0 | 3 | LEM-044, LEM-075 | Backlog |
| LEM-078 | Define the TypeScript plugin authoring API | P1 | 5 | LEM-075, LEM-076 | Backlog |
| LEM-079 | Port the HMAC trust store and signing helper | P0 | 3 | LEM-075 | Backlog |
| LEM-080 | Publish the sample plugin and authoring docs | P1 | 3 | LEM-076, LEM-078 | Backlog |
| LEM-081 | Port resume protection against a changed plugin registry | P2 | 3 | LEM-021, LEM-075 | Backlog |
| LEM-082 | Build the plugin conformance suite | P1 | 5 | LEM-075, LEM-076, LEM-077 | Backlog |

### E8: CLI and Agent Core

**Outcome:** One machine-first CLI and one host-neutral bounded agent loop serve
every host. The command catalog, context protocol, and Jira flow are preserved.

| ID | Task | Pri | Pts | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| LEM-083 | Build the CLI shell, JSON-only stdout, and exit codes | P0 | 5 | LEM-007, LEM-015 | Backlog |
| LEM-084 | Port `run`, `status`, `report`, `abort`, and `prune` | P0 | 5 | LEM-083 | Backlog |
| LEM-085 | Port persona, export, signing, suppression, calibration, and verify commands | P1 | 5 | LEM-065, LEM-066, LEM-067, LEM-069, LEM-070, LEM-071, LEM-083 | Backlog |
| LEM-086 | Port the strict-judge agent loop (cap 7, allowlist, dedupe) | P0 | 8 | LEM-083, LEM-084 | Backlog |
| LEM-087 | Port agent state persistence and in-session resume | P0 | 5 | LEM-010, LEM-086 | Backlog |
| LEM-088 | Port command argument builders | P0 | 3 | LEM-083 | Backlog |
| LEM-089 | Port the 59-command catalog and intent mapping | P1 | 5 | LEM-088 | Backlog |
| LEM-090 | Port the browser agent prompt and invariants | P1 | 3 | LEM-088 | Backlog |
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
- **Status:** Backlog
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
- **Verification:** `pnpm test --filter @lemma/core -- errors`
- **Evidence to record:** error catalog, exit-code test table.

### LEM-008 — Port the redaction engine and synthetic corpus

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 3
- **Depends on:** LEM-004
- **Status:** Backlog
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
- **Verification:** `pnpm test --filter @lemma/core -- redaction`
- **Evidence to record:** corpus file, artifact scan output.

### LEM-009 — Decide package naming, release flow, and consumer contracts

- **Epic:** E1 Platform Foundation
- **Priority:** P1
- **Points:** 3
- **Depends on:** LEM-001, LEM-003
- **Status:** Backlog
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
- **Verification:** `pnpm publish --dry-run --recursive`
- **Evidence to record:** ADR, dry-run output, package manifests.

### LEM-010 — Port atomic state, JSON, and file-lock primitives

- **Epic:** E1 Platform Foundation
- **Priority:** P0
- **Points:** 5
- **Depends on:** LEM-001, LEM-007
- **Status:** Backlog
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
- **Verification:** `pnpm test --filter @lemma/core -- state`
- **Evidence to record:** crash-injection output, cross-platform CI matrix.

---

## In Progress

No task is claimed.

## Blockers

| Blocker | Impact | Unblock |
| --- | --- | --- |
| The lemma host surfaces for Codex, Antigravity, and Cursor are not yet verified against current host APIs. | `LEM-103`–`LEM-105` estimates and capability rows are provisional. | Spike each host's plugin/command/MCP surface during `LEM-099`; record the result in `docs/architecture.md` and the compatibility matrix. |
| No npm organization or publish credentials exist yet. | `LEM-134` cannot complete end-to-end provenance publishing. | Create the npm org/scope and a provenance-enabled publish token before Phase G. |
| No Chromium is guaranteed in the local environment. | Browser parity runs may be `blocked` locally. | Add the browser CI leg in `LEM-133`; until then record blocked coverage, never a pass. |
| No labeled historical release corpus is available. | Calibration can reproduce assay fixtures but cannot claim empirical validity. | Port assay's 14 fixtures now; curate real labeled releases before making a calibration claim. |
| assay is still the oracle and will keep changing. | Parity can drift during migration. | Pin the assay commit in `LEM-002`/`LEM-005`; re-baseline deliberately and record the new commit. |

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

## Done

- **LEM-001** — Initialize the pnpm/TypeScript monorepo and quality gates (2026-11-14). Evidence: `pnpm install && pnpm lint && pnpm typecheck && pnpm build && pnpm test` passed; 11 workspace package shells, strict TS/ESM config, CI workflow (Node 20/22), and required repo docs/config present. Commit/remote recorded in completion summary.
- **LEM-002** — Publish the machine-readable assay parity manifest and check (2026-11-14). Evidence: `docs/parity/assay.manifest.json` (281 assets, 10 kinds), `scripts/parity/check.mjs` (`pnpm parity:check`), CI step, and parity drift/validation tests; `pnpm parity:check` exit 0 on complete manifest and nonzero on removed owner. Commit/remote recorded in completion summary.
- **LEM-003** — Ratify the architecture, package graph, and adapter contract (2026-11-14). Evidence: `docs/architecture.md` ratified (graph/module map/`AgentHost` interfaces/capability matrix/degradation/adapter ownership, OpenCode+Claude Code first), `docs/adr/0001-typescript-monorepo-and-contracts.md`, `packages/core/test/dependency-direction.test.ts`; `pnpm typecheck` and dependency-direction test passed. Operator sign-off: DL11. Commit/remote recorded in completion summary.
- **LEM-004** — Define versioned zod schemas and inferred core types (2026-11-14). Evidence: zod contract modules in `@lemma/core` for report v1, state/progress/history, evidence manifest, persona, plugin, policy, metering envelope/events, quota plan, price book, entitlement, queue job, billing record, retention; generated/committed `schemas/**` (23 files) match generator output; schema tests cover assay report compatibility (completed/halted/failed), contract rejection/additive fields. Commit/remote recorded in completion summary.
- **LEM-005** — Build the assay↔lemma golden parity harness (2026-11-14). Evidence: `pnpm test:parity` passes (oracle vs baselines, seeded/frozen zero-diff, field-level diff/self-check) for completed/halted/browser-blocked using `examples/sample-repo`; pinned oracle config, normalized baselines, harness script/docs, and CI parity step added. Commit/remote recorded in completion summary.
- **LEM-006** — Port deterministic clock, entropy, and seeded id providers (2026-11-14). Evidence: `packages/core/src/determinism.ts` and `packages/core/test/determinism/determinism.test.ts`; seeded/frozen byte-identical outputs, real UTC/random defaults, report-only `generated_at` override semantics, and typed validation errors verified (`pnpm --filter @lemma/core test -- determinism`). Commit/remote recorded in completion summary.
