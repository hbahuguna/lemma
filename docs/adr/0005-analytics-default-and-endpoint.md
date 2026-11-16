# ADR 0005: Anonymous usage analytics default, endpoint, and payload schema

- **Status:** Accepted
- **Date:** 2026-11-16
- **Owners:** LEM-152
- **Related:** `packages/core/src/analytics.ts`, `packages/core/src/settings.ts`, `packages/core/src/state-store.ts`, `BOARD.md` (LEM-152)

## Context

Lemma needs optional, anonymous usage analytics with a clear opt-out and no code, prompts, or personal data. Analytics must never block, slow, or fail a run. The default-on/off choice is a policy decision and must be recorded explicitly.

## Decision

1. **Default:** analytics are **disabled by default** (`analytics.enabled = false` in `lemma.settings/v1` defaults). Users opt in explicitly via settings (`analytics.enabled=true`) or environment override where applicable.
2. **Opt-out / disable controls:**
   - Settings: `analytics.enabled=false` disables analytics (authoritative project setting).
   - Environment: `LEMMA_ANALYTICS=off|0|false|disabled` forces analytics **off** (no-op) regardless of settings.
   - `LEMMA_ANALYTICS=on|1|true|enabled` may enable emission only when settings also allow it (settings remain the persisted preference); env `off` always wins.
3. **Endpoint:** default endpoint is `https://analytics.lemma.dev/v1/events` (configurable via settings `analytics.endpoint`; endpoint is used only when analytics are enabled and not forced off). Network delivery is best-effort and asynchronous.
4. **Install identity:** a per-install random UUID is generated and stored at `.lemma/analytics-install-id` (atomic write, inside `.lemma/` only). No other stable user/device identifiers are collected.
5. **Event allowlist (names):** `run_started`, `run_completed`, `run_failed`, `command_invoked`, `settings_toggled`.
6. **Property allowlist and payload schema (exact):**
   - Envelope: `{ "schema_version": "lemma.analytics/v1", "event": "<allowed name>", "install_id": "<uuid-from-.lemma/analytics-install-id>", "timestamp": "<ISO-8601>", "props": { ...allowed props only... } }`
   - `run_started`: `props` allowlist `{ "workflow"?: string, "resume"?: boolean }`
   - `run_completed`: `props` allowlist `{ "workflow"?: string, "status"?: string, "duration_ms"?: number }` (duration is coarse runtime metadata, not content)
   - `run_failed`: `props` allowlist `{ "workflow"?: string, "status"?: string }`
   - `command_invoked`: `props` allowlist `{ "command"?: string }` (command name only)
   - `settings_toggled`: `props` allowlist `{ "enabled"?: boolean }`
7. **Privacy/data minimization:** no prompts, no source/code, no file contents, no paths outside repo root, no raw targets/URLs, no user identifiers, and no IDs beyond the per-install random UUID. Properties not in the event allowlist are stripped. Unknown event names are rejected with a typed error.
8. **Reliability:** events are buffered and flushed asynchronously with a hard timeout. Network/flush failures never fail the run, never appear in stdout, and emit diagnostics to stderr only. `recordEvent` is non-blocking with respect to run correctness.
9. **Audit:** settings changes (including `analytics.enabled` toggles) are recorded as JSONL audit events via `StateStore.saveSettings` (`settings_changed` with redacted previous/new values).

## Consequences

- Privacy-preserving default (opt-in) with clear controls.
- Deterministic validation/stripping behavior and bounded payloads.
- Observability cannot impact correctness or leak sensitive data.

## Privacy review notes

- Data classes collected: anonymous install UUID, coarse event names, and strictly allowlisted operational metadata.
- Excluded: content, secrets, prompts, code, repository paths, identities, and environment details beyond allowed coarse fields.
- Transport failures are silent to product flow except stderr diagnostics; no retry persistence of sensitive data.
