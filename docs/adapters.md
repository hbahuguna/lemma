# Adapter compatibility matrix and host integration docs

This document publishes the current host adapter compatibility matrix, install/packaging
surface, and in-repo verification status for lemma host integrations.

**Status:** reflects implemented adapter packages and in-repo (no live host runtime)
conformance/end-to-end/smoke verification as of 2026-11-16. Capabilities and host API
details marked **provisional/TBD** are **not verified** against live host runtimes in
this environment and must remain declared limitations (never silently emulated).

See also: [`docs/architecture.md`](./architecture.md), [`docs/cli-and-agent.md`](./cli-and-agent.md),
[`AGENTS.md`](../AGENTS.md), [`BOARD.md`](../BOARD.md).

## Supported hosts and adapter packages

| Host ID | Host | Adapter package | Manifest name | Status |
| --- | --- | --- | --- | --- |
| `opencode` | OpenCode | `@lemma/adapters-opencode` | OpenCode | Implemented; in-repo e2e parity suite (LEM-109) |
| `claude-code` | Claude Code | `@lemma/adapters-claude-code` | Claude Code | Implemented; in-repo e2e suite (LEM-110) |
| `codex` | Codex | `@lemma/adapters-codex` | Codex | Implemented (provisional host surface); in-repo smoke suite (LEM-111) |
| `antigravity` | Antigravity | `@lemma/adapters-antigravity` | Antigravity | Implemented (provisional host surface); in-repo smoke suite (LEM-111) |
| `cursor` | Cursor | `@lemma/adapters-cursor` | Cursor | Implemented (provisional host surface); in-repo smoke suite (LEM-111) |

All adapters implement the shared `AgentHost` contract/capability manifest from
`@lemma/adapters-sdk`, use host-neutral primitives from `@lemma/agent` for
catalog/intent/command builders and browser prompt helpers, and are exercised via
injected/fake primitives and SDK conformance (no host SDK runtime dependency at
build/test time).

## Compatibility matrix

Declared **adapter default capabilities** below reflect current exported adapter
manifests/constants in this repository. `Yes` = declared available by default,
`No` = declared unavailable by default (honest degradation/limitation). Host API
availability beyond these defaults may be unverified/provisional (see per-host notes).

| Capability | `opencode` | `claude-code` | `codex` | `antigravity` | `cursor` |
| --- | --- | --- | --- | --- | --- |
| Commands / slash commands | Yes | Yes | Yes (provisional command pack helper) | Yes | Yes |
| Registered tools | Yes | Yes (via injected primitives; host MCP/plugin wiring TBD) | No (limited/unverified) | Yes | Yes (via injected primitives) |
| Question UI | Yes | Yes | Yes | Yes | No (partial/unverified; treated unavailable by default) |
| Native forms | No (token-safe paste/env-ref default) | No (TBD/unverified) | No | No (TBD/unverified) | No |
| MCP resource discovery | Yes | Yes | Yes | Yes | Yes |
| Session event stream | Yes | Yes (hooks/events modeled) | No (limited/unverified) | No (TBD/unverified) | No (limited/unverified) |
| Progress stream | Yes | Yes | Yes | Yes | Yes |
| Model invocation | Yes | Yes | Yes | Yes | Yes |
| Background tasks | Yes | No (limited/unverified) | No | No (TBD/unverified) | No |
| Worktrees | Yes | No | No | No | No |

### Required degradation behavior (capability-honest)

Missing/unavailable capabilities must be declared and handled honestly (never silently
emulated). Negotiation/degradation primitives (`@lemma/adapters-sdk`) and adapter
conformance enforce this contract:

| Limitation / missing capability | Required behavior |
| --- | --- |
| Question UI unavailable (`question_ui_unavailable`) | Ask in plain chat, record limitation, never block the run |
| Native forms unavailable (`native_form_unavailable`) | Fall back to paste or secure env reference; never ask for raw token in prose |
| MCP unavailable (`mcp_unavailable`) | Record limitation; continue with paste or skip |
| Session events unavailable (`session_events_unavailable`) | Disable interactive resume; keep persisted-state resume |
| Model invocation unavailable (`model_invocation_unavailable`) | Stop agent loop after deterministic run and report limitation |
| Progress stream unavailable (`progress_stream_unavailable`) | Buffer progress and emit at phase boundaries |

## Install and packaging

Host integration assets are installed per project via the machine-first CLI installer
(LEM-107), using shared template generators (`@lemma/agent`) and shared per-host
packaging manifest/layout definitions (`@lemma/adapters-sdk`, LEM-108). No host
runtime, absolute checkout paths, or build-time host SDK dependencies are required.

```bash
lemma install <host> [--dir <project>] [--dry-run] [--force]
# hosts: opencode | claude-code | codex | antigravity | cursor
```

Installer JSON output reports host, target dir, flags, and planned/written/skipped
file paths/counts. Existing files are not overwritten without `--force`; `--dry-run`
reports without writing.

**Assets installed per host (deterministic, template-derived):**
- 59 assay catalog command templates (from `@lemma/agent` `ASSAY_COMMAND_CATALOG`)
- 5 operational command templates: `assay`, `assay-status`, `assay-report`,
  `assay-abort`, `assay-verify-evidence`
- 1 lemma skill template: `SKILL.md`

| Host | Commands directory | Skill path |
| --- | --- | --- |
| `opencode` | `.opencode/commands` | `.opencode/skills/lemma/SKILL.md` |
| `claude-code` | `.claude/commands` | `.claude/skills/lemma/SKILL.md` |
| `codex` | `.codex/commands` | `.codex/skills/lemma/SKILL.md` |
| `antigravity` | `.antigravity/commands` | `.antigravity/skills/lemma/SKILL.md` |
| `cursor` | `.cursor/commands` | `.cursor/skills/lemma/SKILL.md` |

Each adapter package exports a validated `*_PACKAGING_MANIFEST` constant consistent
with these layouts and asset counts/names.

## Per-host status

### OpenCode (`@lemma/adapters-opencode`)
- **Defaults:** commands/tools/question UI/MCP/session events/progress/model/background/worktrees enabled; native forms unavailable by default (paste/env-ref).
- **Surfaces:** `OPENCODE_ADAPTER_MANIFEST`, `OPENCODE_PACKAGING_MANIFEST`, `createOpenCodeHost`, `createOpenCodeCommandDescriptors`/`registerOpenCodeCommands`, `resolveOpenCodeCatalogInvocation`, `buildOpenCodeBrowserAgentPrompt`.
- **Verification:** adapter/conformance/mapping tests (LEM-101) and in-repo OpenCode end-to-end parity suite (LEM-109) covering install/assets, adapter/host/conformance/command-prompt mapping, and deterministic CLI run/status/report parity without a live OpenCode runtime.
- **Notes:** live host-runtime plugin wiring/event subscription remain follow-on work.

### Claude Code (`@lemma/adapters-claude-code`)
- **Defaults:** commands/tools/question UI/MCP/session events/progress/model enabled; native forms, background tasks, and worktrees unavailable by default (provisional/TBD host details).
- **Surfaces:** `CLAUDE_CODE_ADAPTER_MANIFEST`, `CLAUDE_CODE_PACKAGING_MANIFEST`, `createClaudeCodeHost`, `createClaudeCodeCommandDescriptors`/`registerClaudeCodeCommands`, `resolveClaudeCodeCatalogInvocation`, `buildClaudeCodeBrowserAgentPrompt`.
- **Verification:** adapter/conformance/mapping tests (LEM-102) and in-repo Claude Code end-to-end suite (LEM-110) covering install/assets, adapter/host/conformance/command-prompt mapping, and deterministic CLI run/status/report parity without a live Claude Code runtime.
- **Notes:** host form/MCP/plugin/background/task APIs not verified in this environment; behavior remains capability-honest and provisional.

### Codex (`@lemma/adapters-codex`) — provisional
- **Defaults:** commands/question UI/MCP/progress/model enabled; tools, native forms, session events, background tasks, worktrees unavailable by default.
- **Surfaces:** `CODEX_ADAPTER_MANIFEST`, `CODEX_PACKAGING_MANIFEST`, `createCodexHost`, `createCodexCommandDescriptors`/`registerCodexCommands`, `createCodexCommandPack` (format `lemma.codex-command-pack/provisional`), `resolveCodexCatalogInvocation`, `buildCodexBrowserAgentPrompt`.
- **Verification:** adapter/conformance/mapping/command-pack tests (LEM-103) and in-repo Codex smoke suite (LEM-111) covering install/assets, adapter/host conformance, and representative command/command-pack/prompt mapping.
- **Notes:** Codex command-pack/host API format and limited/unverified capabilities are provisional pending live host validation.

### Antigravity (`@lemma/adapters-antigravity`) — provisional
- **Defaults:** commands/tools/question UI/MCP/progress/model enabled; native forms, session events, background tasks, worktrees unavailable by default.
- **Surfaces:** `ANTIGRAVITY_ADAPTER_MANIFEST`, `ANTIGRAVITY_PACKAGING_MANIFEST`, `createAntigravityHost`, `createAntigravityCommandDescriptors`/`registerAntigravityCommands`, `resolveAntigravityCatalogInvocation`, `buildAntigravityBrowserAgentPrompt`.
- **Verification:** adapter/conformance/mapping tests (LEM-104) and in-repo Antigravity smoke suite (LEM-111) covering install/assets, adapter/host conformance, and representative command/prompt mapping.
- **Notes:** extension/tool/form/session/background surfaces are provisional/TBD pending live host validation.

### Cursor (`@lemma/adapters-cursor`) — provisional
- **Defaults:** commands/tools/MCP/progress/model enabled; question UI treated unavailable by default (partial/unverified), native forms/session events/background tasks/worktrees unavailable.
- **Surfaces:** `CURSOR_ADAPTER_MANIFEST`, `CURSOR_PACKAGING_MANIFEST`, `createCursorHost`, `createCursorCommandDescriptors`/`registerCursorCommands`, `resolveCursorCatalogInvocation`, `buildCursorBrowserAgentPrompt`.
- **Verification:** adapter/conformance/mapping tests (LEM-105) and in-repo Cursor smoke suite (LEM-111) covering install/assets, adapter/host conformance, and representative command/prompt mapping.
- **Notes:** command/MCP/question/form/session/background surfaces are provisional/TBD pending live host validation.

## Verification and evidence

Primary in-repo evidence for adapter compatibility and docs:

- **SDK/conformance:** `packages/adapters/sdk/test/agent-host-sdk.test.ts`, `capability-negotiation.test.ts`, `adapter-conformance-kit.test.ts`, `packaging-manifest.test.ts` (`docs/parity/evidence/LEM-098..100`, `LEM-108` outputs)
- **Adapters:** `packages/adapters/*/test/*-adapter.test.ts` (`docs/parity/evidence/LEM-101-opencode-adapter-test-output.txt`, `LEM-102-claude-code-adapter-test-output.txt`, `LEM-103-codex-adapter-test-output.txt`, `LEM-104-antigravity-adapter-test-output.txt`, `LEM-105-cursor-adapter-test-output.txt`)
- **Templates/installer/packaging:** `packages/agent/test/templates.test.ts`, `packages/cli/test/cli-install.test.ts`, adapter packaging manifests (`docs/parity/evidence/LEM-106*`, `LEM-107*`, `LEM-108*`)
- **Suites:** OpenCode e2e parity `packages/adapters/opencode/test/opencode-e2e-parity.test.ts` (`docs/parity/evidence/LEM-109-opencode-e2e-parity-test-output.txt`), Claude Code e2e `packages/adapters/claude-code/test/claude-code-e2e.test.ts` (`docs/parity/evidence/LEM-110-claude-code-e2e-test-output.txt`), Codex/Antigravity/Cursor smoke `packages/adapters/{codex,antigravity,cursor}/test/*-smoke.test.ts` (`docs/parity/evidence/LEM-111-host-smoke-test-output.txt`)
- **Suite entry point:** root `package.json` `test:e2e` runs current host adapter e2e/smoke suites.

Host-runtime plugin wiring, live host API validation, and installer/runtime packaging
beyond tested surfaces remain follow-on work where noted.
