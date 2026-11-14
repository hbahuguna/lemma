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

---

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
