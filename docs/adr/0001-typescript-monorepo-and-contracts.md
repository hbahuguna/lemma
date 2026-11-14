# ADR 0001: TypeScript monorepo, contracts, and optional capability boundaries

- **Status:** Accepted
- **Date:** 2026-11-14
- **Owners:** LEM-003 (architecture ratification)
- **Related:** `docs/architecture.md`, `BOARD.md` (DL1, DL4, DL5, DL7, DL8), LEM-004, LEM-009, LEM-050

## Context

`lemma` is the TypeScript successor to `assay` and must ship as installable integrations for OpenCode, Claude Code, Codex, Antigravity, and Cursor while preserving deterministic, inspectable release-confidence behavior. The implementation needs a single source of truth for engine behavior, host-neutral orchestration, and versioned contracts without forcing browser automation, cloud services, or host SDKs into every install.

## Decision

1. **Language/runtime:** TypeScript, **ESM-only**, targeting **Node.js 20+** with `strict` compiler settings.
2. **Repository layout:** a **pnpm workspace monorepo** with one-way package dependencies:
   - `@lemma/core` — deterministic engine and contracts boundary (no host/runtime adapters).
   - `@lemma/agent` — host-neutral bounded agent loop over core/CLI contracts.
   - `@lemma/cli` — machine-first CLI surface.
   - `@lemma/browser` — optional Playwright-backed Operate implementation.
   - `@lemma/cloud` — optional metering/auth/quota/ledger/billing/queue/retention services.
   - `@lemma/adapters-*` — thin host-specific integrations depending on `@lemma/agent`.
3. **Contracts:** use **zod** as the schema-first contract source for core/runtime data structures, with **inferred TypeScript types** and generated JSON Schemas published from those contracts (implemented in LEM-004). Contract changes follow schema/versioning rules in `AGENTS.md`.
4. **Optional capabilities:** browser and cloud behavior ship behind **optional subpaths, peer dependencies, feature flags, and/or dynamic imports** as appropriate. Installing `@lemma/core` (and the base OSS CLI path) must **not** require Playwright, a host SDK, or cloud credentials/providers.
5. **Host integration boundary:** adapters implement the shared `AgentHost`/capability-negotiated interface from `docs/architecture.md`; deterministic ordering, scoring, evidence, and kill semantics remain in core/orchestrator code, not in models or host glue.

## Consequences

- One deterministic implementation can be reused across hosts; adapters stay thin and capability-honest.
- Contract drift is reduced by schema-first definitions and parity/contract tests.
- Optional installs remain lightweight and CI/offline-friendly; missing capabilities become explicit blocked/limited behavior rather than silent emulation.
- Package naming/export details and publish flow are finalized in LEM-009; YAML parser and schema-generation specifics are finalized in LEM-012/LEM-004.

## Alternatives considered

- **Separate per-host implementations:** rejected due to inevitable behavior drift and duplicated security/scoring logic.
- **Bundling Playwright/cloud/host SDKs as required dependencies:** rejected; violates optionality and increases install/attack surface.
- **Hand-written interfaces without schema validation:** rejected; weaker parity guarantees and higher migration risk from assay.