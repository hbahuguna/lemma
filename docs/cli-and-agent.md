# CLI and agent behavior

This document describes the current `lemma` CLI and host-neutral agent behavior
as implemented in this repository (E8 CLI and Agent Core). It is a behavior
reference for developers and adapter authors, not a full user-guide replacement.

**Status:** pre-alpha implementation details; behavior is governed by
[`AGENTS.md`](../AGENTS.md), [`BOARD.md`](../BOARD.md), and task evidence under
`docs/parity/evidence/`.

## CLI behavior

- **Machine-first contract:** `lemma run` is intended to emit exactly one JSON
  report object to **stdout**. Progress and warnings belong on **stderr** so
  stdout remains machine-parseable (piped to `jq`, CI, etc.). CLI failures must
  not print stack traces to stdout.
- **State and artifacts:** run state lives under `.lemma/` (not `.harness/`).
  Writes are atomic, evidence is hashed/manifested, and a crash must not leave
  half-written progress or a manifest claiming a missing artifact.
- **Release signal semantics:** blocked, skipped, errored, or refused work is a
  **coverage gap** (never a pass and never a confidence increase). A halted run
  stays halted and forces a hold decision; there is no automatic resume of a
  halted run.
- **Determinism:** the orchestrator/core owns phase order, planning/budget,
  scoring, and kill-switch behavior. Models/adapters do not set scores or
  reorder fixed phases.

**Key implementation areas:** `packages/cli/src/*` (shell/arg parsing/command
dispatch and handlers), `packages/core/src/*` (orchestrator, state, evidence,
report, policy/scoring), schemas under `schemas/`, and CLI/contract tests and
evidence recorded in `BOARD.md` (e.g. LEM-083–LEM-085).

## Command surface

The CLI surface is ported incrementally (see `BOARD.md` E8/E6 tasks and parity
inventory). Current/ported command families include:

- **Core run lifecycle:** `run`, `status`, `report`, `abort`, `prune`
  - `run`: execute an assessment and produce the machine-readable report contract.
  - `mcp`: start the stdio MCP server (`@lemma/core/mcp`). stdout carries
    JSON-RPC protocol lines only; progress goes to stderr. Host plugins launch
    `lemma mcp` rather than importing core directly.
  - `status`/`report`: inspect persisted run/report state.
  - `abort`: request/record abort semantics (kill-switch/halt behavior remains
    core-owned and fail-closed).
  - `prune`: retention/cleanup operations under `.lemma/` per implemented policy.
- **Personas and contracts:** persona listing/lint/scaffolding-related surfaces
  (as implemented in CLI/core tasks; ownership/disjointness remains a contract
  invariant).
- **Export and verification:** report/export and evidence/report verification
  surfaces (e.g. SARIF/JUnit export, signing/verification, `verify-evidence`)
  where ported.
- **Policy/calibration/suppressions and other management commands:** versioned
  policy/gate handling, calibration, suppressions, and related operational
  commands as implemented by completed CLI/core tasks.

Use `lemma --help` / command help for exact flags and current availability in a
given build. Host adapters should invoke the CLI/core through the shared,
machine-readable interfaces rather than scraping human output.

## Agent loop

`@lemma/agent` (`packages/agent/src/index.ts`) provides a host-neutral,
deterministic **strict-judge** loop core (`runStrictJudgeLoop`) with injectable
dependencies (`runHarness`, `askLlm`, optional `progress`/`sendFinal`/hooks).

- **Harness-owned control:** the loop/orchestrator logic controls execution and
  decisions; the LLM proposes structured decisions only. No model-generated
  finding/score/decision is trusted as authoritative.
- **Allowed decisions/commands:** strict JSON decisions are parsed for
  `command`, `need_user_context`, and `done` (plus invalid handling). Harness
  commands are allowlisted (bounded operational set such as `run`, `report`,
  `status`, `abort`, `assay-browser`, `assay-demo`) and disallowed commands are
  rejected.
- **Cap and dedupe:** bounded iteration/step cap (default/max 7, including the
  initial run step semantics as implemented), signature-based dedupe of executed
  commands/args/env-relevant inputs so duplicates are not rerun, and
  min-harness-run enforcement before early completion is accepted.
- **Persisted state and resume:** versioned agent state can be persisted under
  `.lemma/agent/` (atomic, redacted) keyed by goal/initial args or explicit
  state key/session context. Runs can resume in-session/non-interactively with
  provided `userInput` (e.g. context replies), rehydrating progress/dedupe state
  without rerunning completed commands; stale pending interactive state is not
  blindly resumed without an explicit reply.
- **Injectable hooks:** `progress`, `sendFinal`, `listMcpResources`, and
  `requestUserInput` enable host integration without host SDK imports in core
  agent logic.

**Tests/evidence:** `packages/agent/test/agent-loop*.test.ts`,
`packages/agent/test/agent-state.test.ts`,
`packages/agent/test/progress-narrative.test.ts`, and corresponding
`docs/parity/evidence/LEM-086*`, `LEM-087*`, `LEM-094*`, `LEM-096*`.

## Command catalog and builders

`@lemma/agent` ports host-neutral command argument builders and the canonical
slash-command catalog/intent mapping for adapters:

- **Builders (`packages/agent/src/command-args.ts`):** `extractUrl`, `isUrl`,
  `SUBCOMMANDS`, and `browserInvocation` / `demoInvocation` / `assayInvocation`.
  - `assay-browser`: requires a reachable http(s) URL (no directory-only
    fallback), builds live browser runs **without** `--no-browser`, applies
    comprehensive defaults, and allows explicit overrides/safe flag passthrough.
  - `assay-demo`: static inventory when no URL is provided; live browser run when
    a URL is provided.
  - `assay`/generic forms: use URL as live target when present, keep static
    default when no URL is present, and pass CLI subcommands/help/version
    through unchanged.
  - `commandToArgs` delegates assay-style forms for loop integration.
- **Catalog (`packages/agent/src/catalog.ts`):** `ASSAY_COMMAND_CATALOG`
  (canonical 59 commands in assay order), `assayIntent` (`Assay <label> assessment`),
  `getAssayCommand`, `getCatalogCommandKind`, and `buildCatalogInvocation`.
  - `assay-browser` → browser kind, URL-required live builder semantics.
  - `assay-demo` → demo kind, static-without-URL/live-with-URL semantics.
  - All other catalog commands → deterministic static runs:
    `run --target . --no-browser --personas-dir <dir> --intent "Assay <label> assessment"`.

**Tests/evidence:** `packages/agent/test/command-args.test.ts`,
`packages/agent/test/catalog.test.ts`,
`packages/agent/test/command-catalog-parity.test.ts`,
`docs/parity/evidence/LEM-088*`, `LEM-089*`, `LEM-095*`.

## Context protocol and question flow

The agent implements a host-neutral context/question flow integrated with the
loop (`packages/agent/src/index.ts`) and browser prompt contract
(`packages/agent/src/browser-agent-prompt.ts`):

- **Pending context states:** structured `need_context` (source selection) and
  `need_method` (delivery method selection) transitions, resumable via persisted
  state and user replies.
- **Replies:** parsing detects skip and tagged replies such as `[source:*]`,
  `[method:paste|mcp|token]`, `[env:*]` / `[secret_ref:*]`, `[id:*]`,
  `[server:*]`, plus redacted freeform text. Context application advances/clears
  pending state and records redacted context decisions.
- **Interactive/non-interactive:** non-interactive runs pause on
  `need_user_context` and resume with provided `userInput`; interactive mode can
  wait for in-session replies via `requestUserInput` (with timeout handling) and
  continue without rerunning completed commands.
- **Browser prompt invariants:** `CONTEXT_PROTOCOL` / `buildBrowserAgentPrompt`
  require native question-tool UX (no placeholder waits/shell pauses/stdin
  blocking), include Skip/Paste/MCP/Secure env-secret ref options, route Jira
  through the native form tool path (`assay_jira_context`) with token-safe
  handling, and embed deterministic harness-owned/evidence/scoring invariants,
  fixed-phase expectations, no-repeat commands, coverage-gap semantics, and
  safe testing/scenario guidance.
- **Jira context flow (`packages/agent/src/jira-context.ts`):** native-form field
  building (token field omitted when token reference is used), target parsing/
  normalization, ADF flattening, redacted issue summarization/formatting,
  injectable form collection and issue fetch with token-free error mapping, and
  host-integration helpers for mounting a Jira context tool without host SDK
  imports. Tokens/secrets must not reach model-visible summaries, persisted
  state, logs, stdout, evidence, or reports.
- **MCP resource discovery and secret references:** `normalizeMcpResourceEntries`
  / `discoverMcpResources` normalize heterogeneous MCP listings (including
  resources/templates and common nested shapes) into bounded, redacted display
  strings and tolerate discovery failures. Secret-reference handling is explicit
  and token-safe: env/secret-ref metadata is recorded (e.g. `envRef`, `id`,
  `server`) while raw secret values are not captured, echoed, or persisted.

**Tests/evidence:** `packages/agent/test/context-flow.test.ts`,
`packages/agent/test/browser-agent-prompt.test.ts`,
`packages/agent/test/jira-context.test.ts`,
`packages/agent/test/mcp-secret-ref.test.ts`,
`packages/agent/test/agent-loop-prompt-contract.test.ts`,
`docs/parity/evidence/LEM-090*`–`LEM-093*`, `LEM-096*`.

## Progress and final narrative

The agent loop provides host-consumable progress and narrative outputs:

- **Progress:** emits progress messages via `deps.progress` at key points
  (initial assessment, consulting/deciding, executing unique steps, rejections/
  duplicates/disallowed handling, early-completion rejection, completion, and
  iteration-cap) without changing deterministic control flow.
- **Run summaries and IDs:** each harness execution is recorded as a structured,
  redacted summary with command context and extracted report details when output
  is JSON (run id/status/decision, confidence/coverage and check/finding/
  evidence/limitation signals when present), with safe fallback for non-JSON
  output; run IDs are tracked.
- **Final narrative/execution summary:** `buildExecutionSummary` (and loop
  integration) produces a reusable, redacted summary including test plan,
  executed run summaries, context decisions, and run IDs. Completion and
  iteration-cap outcomes (and pending context requests where appropriate)
  include this narrative while preserving done/fix reporting semantics.

**Tests/evidence:** `packages/agent/test/progress-narrative.test.ts`,
`docs/parity/evidence/LEM-094*`.


## Host adapters and installation

`lemma install <host>` installs deterministic, host-appropriate command/skill assets
for supported hosts (`opencode`, `claude-code`, `codex`, `antigravity`, `cursor`)
into a project directory using shared templates and packaging manifests (JSON stdout,
`--dir`/`--root`, `--dry-run`, `--force`). See the published
[adapter compatibility matrix and host integration docs](./adapters.md) for per-host
packages, declared capabilities/degradation, install layouts, and verification status.

For Claude Code, use the real plugin instead of loose `.claude/` files:
[`docs/claude-code-plugin.md`](./claude-code-plugin.md) covers local install,
marketplace registration, the bundled `lemma-*` commands/skill, and the MCP server.


## Related references

- Product/invariant contract: [`README.md`](../README.md), [`AGENTS.md`](../AGENTS.md)
- Work queue and acceptance evidence: [`BOARD.md`](../BOARD.md)
- Architecture: [`docs/architecture.md`](./architecture.md)
- Parity mapping: [`docs/parity/assay-feature-inventory.md`](./parity/assay-feature-inventory.md)
- Agent implementation: `packages/agent/src/`
- CLI implementation: `packages/cli/src/`
- Core contracts: `packages/core/src/`, `schemas/`
