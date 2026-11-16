# ADR 0004: Native MCP server and transport

- **Status:** Accepted
- **Date:** 2026-11-16
- **Owners:** LEM-151
- **Related:** `docs/architecture.md`, `BOARD.md` (LEM-151), `schemas/mcp/`, `packages/core/src/mcp/`

## Context

Lemma needs a first-class MCP (Model Context Protocol) server exposing testing tools to any MCP-compatible coding agent, distinct from adapter-level bridges. The server must be deterministic where applicable, route through `@lemma/core` public APIs only, remain redaction-safe, and be installable/usable without host SDK coupling.

## Decision

1. **Entrypoint/export:** ship native MCP server implementation in `@lemma/core/mcp` (subpath export `@lemma/core/mcp` and source under `packages/core/src/mcp/`) to keep core as the single implementation surface and avoid a new package until architecture requires it.
2. **Pinned protocol revision:** implement MCP protocol revision **`2025-06-18`** for JSON-RPC method shapes used here (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`).
3. **Transport:** support **stdio** transport (newline-delimited JSON-RPC messages) as the primary/conformant transport. Streamable HTTP may be added later behind the same tool handlers; this ADR satisfies LEM-151's `stdio and/or streamable HTTP` requirement via stdio.
4. **Tool surface (minimum):** expose `lemma_start`, `lemma_update`, `lemma_report`, `lemma_settings`, `lemma_demo`, `lemma_knowledge` with committed JSON Schemas in `schemas/mcp/`.
5. **Implementation constraints:** tool handlers call `@lemma/core` public APIs only, return `HarnessError`-shaped error payloads (no stack traces), emit JSON-RPC on stdout only, apply `@lemma/core/redaction` before logging/persisted error surfaces, and perform disk writes only through core state/evidence/demo primitives scoped to target/project `.lemma/` or explicit demo target validation.
6. **Determinism:** `lemma_start` accepts `seed` and `clock` and delegates to deterministic core run/orchestrator paths; repeated seeded calls produce byte-identical run artifacts subject to the same volatile-field contract as the CLI.

## Consequences

- Any MCP-capable client can invoke lemma tools without a host-specific bridge.
- Cursor and other adapters can use the native server/handlers; bridge-specific behavior remains capability-honest and documented.
- Protocol/tool contracts are versioned and testable via repo-owned MCP client fixtures.

## Alternatives considered

- **Dedicated `@lemma/mcp` package now:** deferred; `@lemma/core/mcp` satisfies AC and minimizes dependency-surface change. Revisit if transport/runtime deps grow.
- **HTTP-only transport:** rejected for first slice due to added server/runtime complexity; stdio is sufficient and broadly supported.
