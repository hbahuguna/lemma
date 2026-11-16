# ADR 0003: Local dashboard serving and token auth

- **Status:** Accepted
- **Date:** 2026-11-16
- **Related:** LEM-143 (local visual evidence dashboard)

## Context

Lemma needs a host-neutral, local visual investigation view for an active run without introducing remote exposure, unauthenticated access, or direct filesystem mutation paths outside core stores.

## Decision

- Serve the dashboard **only on `127.0.0.1`** (loopback). Any non-loopback bind attempt (e.g. `0.0.0.0`) is rejected with a typed `HarnessError`.
- Issue a **per-run cryptographically random token** at dashboard start.
- Require the token on **every route** (including `/healthz`, HTML view, and JSON API) via `x-lemma-dashboard-token` header or `token` query parameter.
- **Missing or mismatched tokens** return `401` with a JSON body only.
- Dashboard is **read-only** (no write endpoints in LEM-143) and reads state exclusively through `StateStore`/`EvidenceStore` APIs.
- Dashboard startup is disabled when `LEMMA_DASHBOARD=off` (or equivalent falsey values) or when the caller passes `--no-dashboard` (CLI responsibility). Core `startDashboard` returns a disabled no-op handle when env-disabled.
- Future write/settings endpoints (e.g. LEM-146) must preserve loopback-only binding, per-request token validation, and schema-validated writes through core stores.

## Consequences

- Prevents accidental remote exposure and unauthenticated local access.
- Keeps live view consistent with core state/evidence abstractions and avoids direct filesystem coupling.
- Token-in-query for initial page load is supported for usability but remains required and validated on every request; hosts should prefer header-based access where possible.
