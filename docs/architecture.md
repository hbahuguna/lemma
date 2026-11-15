# lemma architecture

Status: **ratified** by `LEM-003` (2026-11-14). Changes require an ADR and a Decision Log entry. See [ADR 0001](./adr/0001-typescript-monorepo-and-contracts.md).

## Goals

1. One deterministic engine, five host integrations, zero duplicated product
   logic.
2. The core is usable as a library and a CLI with no agent installed.
3. Every host integration is installable from a package registry, not a clone.
4. Optional browser and cloud capability never becomes a required install.
5. Behavior that affects a release decision is explainable from data, not from a
   model's prose.

## Package graph

```text
@lemma/adapters-opencode ─┐
@lemma/adapters-claude   ─┤
@lemma/adapters-codex    ─┼──> @lemma/agent ──> @lemma/core
@lemma/adapters-antigrav ─┤          │              │
@lemma/adapters-cursor   ─┘          │              ├──> schemas (types + zod)
@lemma/cli ──────────────────────────┘              │
@lemma/browser ──(peer: playwright)─────────────────┤
@lemma/cloud ───────────────────────────────────────┘
```

Rules:

- `@lemma/core` imports no host SDK, no CLI framework, no Playwright, and no
  network client beyond the explicitly validated browser/SSRF boundary.
- `@lemma/agent` imports `@lemma/core` and host-neutral interfaces only.
- `@lemma/adapters-*` import `@lemma/agent` and one host SDK.
- `@lemma/browser` is optional. `@lemma/core` exposes a `BrowserRunner` port; the
  browser package supplies the Playwright implementation.
- `@lemma/cloud` is optional. The OSS CLI never requires it.
- Schemas are the contract. Packages exchange inferred TypeScript types, not
  hand-maintained interfaces.

### Adapter ownership and ship order

| Host | Adapter package | Owner | First-ship status |
| --- | --- | --- | --- |
| OpenCode | `@lemma/adapters-opencode` | LEM-101 | **Ship first** (immediate target, with Claude Code) |
| Claude Code | `@lemma/adapters-claude-code` | LEM-102 | **Ship first** (immediate target, with OpenCode) |
| Codex | `@lemma/adapters-codex` | LEM-103 | Follow-on (shared conformance kit) |
| Antigravity | `@lemma/adapters-antigravity` | LEM-104 | Follow-on (shared conformance kit) |
| Cursor | `@lemma/adapters-cursor` | LEM-105 | Follow-on (shared conformance kit) |

All adapters implement the shared `AgentHost` contract and capability manifest, and must pass the shared conformance kit before being documented as supported.

## Core modules

| Module | Responsibility |
| --- | --- |
| `orchestrator` | Five-phase state machine, budget, kill switch, resume, finalization |
| `determinism` | Injectable clock, entropy, seeded id sequences |
| `workflows` | Versioned workflow loader, phase-order validation, built-in fallback |
| `checks` | Stable check catalog, registry, intent-linked planning |
| `findings` | Persona output-contract validation, invalid-finding quarantine, contract-failure streaks, finding fingerprints |
| `outcomes` | Check outcome application, structured blocker/refusal records, non-blocked finding/quarantine integration |
| `personas` | Frontmatter parsing, contract loading, schema validation, ownership derivation/disjointness enforcement |
| `static` | Source inventory, git-aware scanning, secret/unsafe/a11y rules |
| `evidence` | Hashed artifact store, checkpoint manifest, signing, verification |
| `scoring` | `weighted-coverage-v1` math, caps, gate policy |
| `report` | `lemma.report/v1` builder and JSON Schema validation |
| `state` | Atomic progress, events, history, retention, kill file |
| `risk` | Risk ranking from the inventory |
| `plugins` | Signed registry, plugin context, blocked-failure handling |
| `redact` | Redaction before persistence |
| `ssrf` | URL validation, DNS resolution, allowlists, redirect revalidation |
| `steps` | Scenario-file planner and runner primitives |
| `policy` | Versioned gate and weight policy |

## Host adapter contract

Every adapter implements a narrow, capability-negotiated surface. The core and
agent loop never call a host API directly.

```ts
export interface AgentHost {
  readonly id: "opencode" | "claude-code" | "codex" | "antigravity" | "cursor"
  readonly capabilities: HostCapabilities

  registerCommands(commands: CommandDescriptor[]): Promise<void>
  registerTools(tools: ToolDescriptor[]): Promise<void>

  sendProgress(message: string): Promise<void>
  sendFinal(message: string): Promise<void>

  askQuestion(request: QuestionRequest): Promise<QuestionAnswer>
  collectForm?(request: FormRequest): Promise<FormAnswer | null>
  listMcpResources?(): Promise<McpResource[]>

  getSession(): SessionContext
  resolveSecret?(ref: SecretRef): Promise<string>
}

export interface HostCapabilities {
  commands: boolean
  tools: boolean
  questionUi: boolean
  nativeForms: boolean
  mcpResources: boolean
  sessionEvents: boolean
  progressStream: boolean
  modelInvoke: boolean
  backgroundTasks: boolean
  worktrees: boolean
}

export interface CommandDescriptor {
  name: string                 // e.g. "assay-browser" -> adapter decides spelling
  description: string
  arguments?: ArgumentSpec
  intent: string
  allowedSubcommands: string[] // run | report | status | abort | ...
  mode: "static" | "browser" | "demo" | "agent"
}
```

### Capability matrix and compatibility status

Published, maintained compatibility matrix and per-host docs: **[`docs/adapters.md`](./adapters.md)**.

The table below summarizes **declared adapter default capabilities** (current in-repo
adapter manifests) and provisional host-surface notes. Unverified/TBD host APIs remain
declared limitations with honest degradation (never silently emulated).

| Capability | OpenCode | Claude Code | Codex | Antigravity | Cursor |
| --- | --- | --- | --- | --- | --- |
| Slash commands | Yes | Yes | Yes (provisional command-pack helper) | Yes | Yes |
| Registered tools | Yes | Yes (injected primitives) | No (limited/unverified) | Yes | Yes (injected primitives) |
| Question UI | Yes | Yes | Yes | Yes | No (partial/unverified; default unavailable) |
| Native forms | No (paste/env-ref default) | No (TBD/unverified) | No | No (TBD/unverified) | No |
| MCP resource discovery | Yes | Yes | Yes | Yes | Yes |
| Session event stream | Yes | Yes | No (limited/unverified) | No (TBD/unverified) | No (limited/unverified) |
| Progress stream | Yes | Yes | Yes | Yes | Yes |
| Model invocation | Yes | Yes | Yes | Yes | Yes |
| Background tasks | Yes | No (limited/unverified) | No | No (TBD/unverified) | No |
| Worktrees | Yes | No | No | No | No |

**LEM-099 spike/negotiation note (2026-11-16, provisional):** host API details for
Codex command-pack/MCP/model/session behavior, Antigravity extension and
tool/form/session surfaces, and Cursor command/MCP/question/form/background behavior
are **not yet verified** against live host APIs in this environment. Until live
host validation confirms them, these capabilities remain provisional and must be
declared as limitations when unavailable (never silently emulated).

**LEM-102 Claude Code adapter note (2026-11-16, provisional/honest):** The
`@lemma/adapters-claude-code` surface treats native forms as unavailable by
default (TBD/unverified host form API in this environment; paste/secure
env-reference fallback), models MCP resource discovery via injected primitives
when provided, treats limited background jobs and worktrees as unavailable by
default unless explicitly provided/verified, and keeps all unverified
capabilities declared honestly through manifest/negotiation (no silent emulation).

**LEM-103 Codex adapter note (2026-11-16, provisional/honest):** The
`@lemma/adapters-codex` surface declares capability-honest defaults for the
current unverified Codex host surface (tools/session events/background jobs/
worktrees/native forms unavailable by default; MCP/commands/question/progress/
model invocation supported via injected primitives when provided) and exports a
provisional serializable command-pack helper shape derived from shared command
descriptors. This does not claim a verified Codex command-pack/host API format;
unknown/limited capabilities remain declared limitations until host-specific
validation (`LEM-103` follow-on packaging/E2E tasks).

**LEM-104 Antigravity adapter note (2026-11-16, provisional/honest):** The
`@lemma/adapters-antigravity` surface declares capability-honest defaults for
the current unverified Antigravity host extension surface (native forms/session
events/background jobs unavailable by default where TBD/unverified; worktrees
unavailable; commands/tools/question/MCP/progress/model invocation supported via
injected primitives when provided). TBD/unverified capabilities remain declared
limitations through manifest/negotiation until host-specific validation.

**LEM-105 Cursor adapter note (2026-11-16, provisional/honest):** The
`@lemma/adapters-cursor` surface declares capability-honest defaults for the
current unverified Cursor host surface (partial question UI and limited session
events treated as unavailable by default for honest degradation; native forms/
background jobs/worktrees unavailable; commands/tools/MCP/progress/model
invocation supported via injected primitives when provided). Partial/limited/
unverified capabilities remain declared limitations through manifest/negotiation
until host-specific validation.

### Degradation rules

| Missing capability | Required behavior |
| --- | --- |
| Question UI | Ask in plain chat, record `question_ui_unavailable`, never block the run |
| Native form | Fall back to paste or secure env reference; never ask for a raw token in prose |
| MCP | Record `mcp_unavailable`; continue with paste or skip |
| Session events | Disable interactive resume, keep persisted-state resume |
| Model invocation | Stop the agent loop after the deterministic run; report the limitation |
| Progress stream | Buffer progress and emit it at phase boundaries |

## Agent loop

The host-neutral loop lives in `@lemma/agent`. It is a bounded judge over the
deterministic engine, not a replacement for it.

- Initial deterministic run is mandatory.
- Hard cap of 7 iterations; each proposed command must be unique.
- Allowed commands are an explicit allowlist mapped to `run`, `report`, `status`,
  `abort`, and browser/demo variants.
- The model may propose one next command or a test plan; it may not write
  findings, set a score, or claim evidence.
- A context checkpoint precedes each next step. Skipping context is recorded.
- Final output must include all run ids, what executed, what was a gap, and
  concrete fixes.
- State persists under `.lemma/agent/<hash>.json` so a session can resume.

## Data flow

```text
host command
  -> adapter parses arguments and capabilities
  -> agent loop (optional)
  -> CLI invocation or library call
  -> orchestrator: risk -> plan -> execute -> evidence -> score
  -> report JSON (stdout) + progress (stderr/UI)
  -> adapter renders a summary and links evidence
```

The adapter never parses evidence itself. It renders the report contract.

## Compatibility and parity

- `lemma.report/v1` must accept every report produced by `assay` v0.1.0 after
  volatile fields are normalized.
- `lemma` runs the `assay` Python implementation as a parity oracle until
  `LEM-139`.
- `LEM-005` builds the comparison harness: same fixture, same options, normalized
  JSON diff, nonzero exit on drift.
- Intentional divergence requires an ADR in `docs/adr/` and a Decision Log entry.

## Security boundaries

1. **Target boundary** — all URLs pass SSRF validation before DNS use or
   navigation; redirects are revalidated.
2. **Host boundary** — adapters receive only the report contract and the minimum
   session context. Secrets are resolved by reference, consumed in memory, and
   never returned to the model.
3. **Persistence boundary** — redaction happens before state, evidence, or log
   writes.
4. **Plugin boundary** — signed registry, single-persona ownership, bounded
   context, no filesystem escape.
5. **Cloud boundary** — tenant identity resolves from a scoped token before any
   quota, evidence, or job lookup.

## Open decisions

| Decision | Owner task |
| --- | --- |
| Package scope (`@lemma/*` vs `lemma-*`) and CLI name | LEM-009 |
| YAML parser choice for workflows | LEM-012 |
| JSON Schema generation from zod | LEM-004 |
| Playwright distribution (peer dep vs bundled) | LEM-050 |
| Claude Code form/MCP surface | LEM-102 (provisional adapter defaults recorded 2026-11-16; host API verification remains follow-on) |
| Codex command-pack format | LEM-103 (provisional helper/shape recorded 2026-11-16; host format verification remains follow-on) |
| Antigravity extension surface | LEM-104 (provisional adapter defaults recorded 2026-11-16; host API verification remains follow-on) |
| Cursor MCP/command surface | LEM-105 (provisional adapter defaults recorded 2026-11-16; host API verification remains follow-on) |
