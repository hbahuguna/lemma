# ADR 0006: Commercial tier boundary, packaging, and entitlement gate

- **Status:** Accepted
- **Date:** 2026-11-16
- **Owners:** LEM-156
- **Related:** `docs/architecture.md`, `docs/adr/0002-package-scope-release-and-consumer-contracts.md`, `packages/pro/*`, `packages/cloud/src/auth.ts`, `packages/cloud/src/signup.ts`, `packages/cloud/src/entitlements.ts`, `schemas/cloud/entitlement.v1.schema.json`, `BOARD.md` (DL17, LEM-156)

## Context

Lemma needs a ratified commercial tier boundary before any Pro feature ships. The boundary must preserve a fully functional open-source core, make entitlement enforcement auditable and typed, and avoid introducing a parallel authentication/entitlement system. Later E18/E19 Pro work depends on this ADR as the single source of truth.

## Decisions

### (a) Tier split

- **`@lemma/core` (free, open-source):** deterministic engine, CLI/agent/runtime contracts, evidence/scoring/reporting/state/redaction/SSRF, and all capabilities not explicitly designated Pro by this ADR or a future ADR that cites this boundary. `@lemma/core` performs **no entitlement check** and never requires Pro infrastructure, credentials, or packages.
- **`@lemma/pro` (commercial, entitlement-gated):** Pro-only command/workflow/integration surfaces (E18/E19 and any future capability explicitly classified Pro). Every Pro capability is gated before execution and refuses cleanly when unlicensed.

### (b) Packaging shape

- **Chosen shape:** separate package **`@lemma/pro`** (not a `@lemma/cloud/pro` subpath).
- **Justification:** a separate package makes the commercial boundary, install/distribution contract, dependency direction, and CI enforcement explicit and auditable; it avoids entangling Pro feature code with cloud service subpaths/exports; it matches the existing optional-package posture (`@lemma/browser`, `@lemma/cloud`) while keeping `@lemma/core` installable and functional without Pro; and it allows independent commercial packaging/versioning without changing core/cloud public surfaces.

### (c) Dependency direction and enforcement

- **Direction:** `@lemma/pro` may depend on **`@lemma/core` public APIs only** (no private/deep imports). `@lemma/pro` may also depend on documented peers for entitlement resolution and Pro-specific concerns (currently: `@lemma/cloud` public entitlement/auth/signup contracts as an optional peer for LEM-114/117 reuse; Node.js built-ins). `@lemma/core` **must not** import `@lemma/pro` (source or runtime dependency). `@lemma/cloud` must not import `@lemma/pro`.
- **CI/test enforcement:** dependency-direction tests in `packages/core/test/dependency-direction.test.ts` assert (1) `@lemma/core` source never imports `@lemma/pro` and (2) `@lemma/pro` source imports only `@lemma/core` and documented peers/built-ins (no reverse/adaptor/host leakage). Workspace manifest/dependency policy tests (`packages/core/test/workspace.test.ts`) include `@lemma/pro` in the allowed one-way dependency graph. These tests run in the standard `pnpm test`/CI flow.

### (d) Entitlement resolution (no parallel auth)

- **Reuse, not reinvention:** Pro entitlement resolution reuses the **LEM-114/LEM-117 scoped-key and entitlement contracts** and verification model. There is **no parallel auth system**.
- **Contracts/surfaces reused:** scoped workspace/key/auth context and ownership primitives from `@lemma/cloud/auth` (LEM-114) and signed entitlement issuance/verification and plan/workspace binding from `@lemma/cloud/signup` + `@lemma/cloud/entitlements` (LEM-117), aligned with `schemas/cloud/entitlement.v1.schema.json` (`lemma.entitlement/v1` / `quality-harness.entitlement/v1` compatibility).
- **Gate input model:** Pro entrypoints accept an already-resolved/verified entitlement or auth+entitlement material produced via those LEM-114/117 contracts (or equivalent injected verifier for tests) and validate it before any Pro work begins. Missing, invalid, expired, tampered, wrong-workspace, insufficient-scope, or unverified material is treated as unlicensed.
- **No silent fallback:** absence of entitlement infrastructure or credentials is not treated as licensed; it yields a typed unlicensed refusal.

### (e) Free-tier refusal behavior

- Unlicensed Pro invocation returns a typed, documented **`ProUnavailableError`** (exported by `@lemma/pro`) with:
  - **Stable code:** `pro_unavailable`
  - **Actionable message:** names the **Lemma Pro** tier, states Pro is required/unavailable for the requested capability, and includes a learn-more link: `https://lemma.dev/pro`
  - **No implementation details leak:** no signing keys, token/key material, internal stack traces, or tenant-specific secret details
  - **No crash, no silent pass, no partial execution:** error is raised/returned before Pro work; no fabricated success, no partial side effects

### (f) Privacy and analytics posture

- Pro follows the **same opt-out and privacy posture as core**: analytics are disabled by default per ADR 0005 and controlled by the same settings/env controls (`analytics.enabled`, `LEMMA_ANALYTICS`); no prompts, code, personal data, or disallowed payload fields.
- **No Pro-only telemetry** is collected unless explicitly disclosed in a future ADR/Decision Log update and surfaced in user-facing documentation/settings. Pro features must not introduce hidden telemetry channels.

## Consequences

- Core remains fully usable without Pro or entitlement infrastructure.
- Pro boundary and entitlement behavior are auditable, typed, and test-enforced.
- Reuse of LEM-114/117 avoids auth/entitlement drift and duplicate trust logic.
- Future Pro features (E18/E19) must cite this ADR and use the shared gate/error contract.

## Verification

- `docs/adr/0006-commercial-tier-boundary-and-packaging.md` records decisions (a)-(f).
- `docs/architecture.md` includes Pro tier in package graph and dependency-direction enforcement.
- `packages/core/test/dependency-direction.test.ts` enforces core↛pro and pro→core(+documented peers).
- `packages/pro/src/entitlement.ts` implements `ProUnavailableError` and entitlement gate reusing LEM-114/117 contracts.
- `packages/pro/test/entitlement-gate/*` verifies licensed/unlicensed behavior.
- `pnpm lint && pnpm typecheck && pnpm build && pnpm test` pass (dependency-direction test picked up by CI/test run).
