# Agent Contract — lemma

This file is the operating contract for any coding agent working on `lemma`.
`BOARD.md` is the work queue; this file is how to use it without weakening the
product.

## Mission

Make release confidence inspectable, and ship it where developers already work.
`lemma` must tell an operator what was executed, what was not, what still blocks
a ship decision, and why the score is what it is — whether it runs from the CLI,
inside OpenCode, Claude Code, Codex, Antigravity, or Cursor.

The business goal is a self-serve, usage-based cloud tier built on a
deterministic open-source core. The plugin surface is the distribution channel;
it is not permission to move decision logic into a model.

## Read order

1. `README.md` for the product contract and invariants.
2. `BOARD.md` for the current task and its acceptance criteria.
3. `AGENTS.md` (this file) for invariants and definition of done.
4. `docs/architecture.md` before adding a package, adapter, or dependency.
5. `docs/parity/assay-feature-inventory.md` before porting a feature.
6. The relevant package and its tests before editing.

## Non-negotiable invariants

- The phase order is fixed: Risk Analysis → Test Planning → Execution → Evidence
  Collection → Confidence Scoring. No adapter, check, or persona may reorder it.
- The orchestrator, not a model, owns ordering, budget, scoring, and the kill
  switch. A specialist may propose a finding; it may not set the final score.
- `lemma run` prints one JSON report to stdout. Progress and warnings go to
  stderr. Never mix human prose into stdout.
- State lives under `.lemma/`. Writes are atomic. A crash must not leave a
  half-written `progress.json` or a manifest that claims an artifact exists.
- Every finding needs an evidence path under `.lemma/evidence/<run_id>/` with a
  SHA-256 hash in the manifest. No evidence, no finding.
- Redact before persistence. A credential, cookie, authorization header, private
  key, or provider token must never reach state, evidence, logs, stdout, or a
  report.
- A blocked, skipped, errored, or refused check is a coverage gap. It is never a
  pass, and it never raises confidence.
- The kill switch halts remaining checks, marks them skipped, sets the run to
  `halted`, and forces a `hold` decision. Do not add a path that resumes a halted
  run automatically.
- The core must not import a host SDK. `core` has no dependency on `agent`,
  `cli`, `browser`, `cloud`, or `adapters`.
- Optional behavior (browser, cloud, host integration) loads behind an explicit
  subpath export, peer dependency, feature flag, or dynamic import. Installing
  `@lemma/core` must not install Playwright or a host SDK.
- Installed check plugins must be signed and owned by exactly one persona. A
  plugin that cannot be loaded or verified is a blocked check, never a pass and
  never a reason to fail the whole run.
- Persona checks must be disjoint. A check owned by zero personas, or by more
  than one, is a configuration error.
- Do not lower a severity to make a gate pass. Fix the evidence, add a justified
  suppression through the board task that owns it, or leave the finding open.
- No UI in the OSS core. Onboarding and usage APIs are allowed; a dashboard is a
  separate product decision.

## Adapter rules

- Adapters translate host capabilities into the shared `AgentHost` interface.
  They do not contain check logic, scoring logic, or phase logic.
- An adapter may not invent a finding, score, decision, or evidence entry. It may
  only transport, render, and request input.
- A missing host capability (question UI, native form, MCP, session events) must
  degrade to a recorded limitation, not a silent fallback that looks equivalent.
- Every adapter declares its capabilities in a machine-readable manifest and
  passes the shared conformance kit.
- Keep host-specific prompts and command shims in the adapter package. Shared
  product prompts live in `packages/agent`.
- A host integration must be installable without cloning the repository. No
  absolute paths to a checkout, no Python bridge, no build step at install time.

## Board protocol

1. Choose the lowest-numbered task in `Ready` whose dependencies are all `Done`.
   If a higher-priority `P0` exists and is unblocked, state why you are taking it
   out of order in the change description.
2. Claim one task per change. Move it to `In Progress` and state the exact
   acceptance test you will run.
3. Read the task's acceptance criteria literally. Do not add adjacent scope; put
   discovered work in `Backlog` as a new story with a new higher-numbered task.
4. Keep dependency chains valid: a task may depend only on a lower-numbered
   task, and no cycle may exist. Renumbering is not allowed after work starts.
5. Move the task to `Done` only when every acceptance criterion has a passing
   test or a verified artifact. Update the Decision Log when a choice changes the
   architecture, scoring, security posture, adapter contract, or commercial
   model.
6. If you are blocked, add a row to `Blockers` with the impact and the exact
   unblock action. Do not silently park a task in `In Progress`.
7. Never edit a completed task's acceptance criteria to match the code. If the
   outcome changed, add a new task and link the old one.

## Definition of done

A task is done only when all of the following are true:

- The acceptance criteria pass in a command another agent can rerun.
- New behavior has a unit, contract, or end-to-end test; bug fixes have a
  regression test.
- The report, evidence, metering, or adapter contract changed in a
  backward-compatible way, or the version was bumped with a migration note.
- Evidence remains hashed and redacted; no fixture value can leak into a report.
- The parity inventory rows that point at the task are updated with evidence.
- The task card is updated, the Decision Log is updated when relevant, and any
  new work is captured as a higher-numbered task.
- `pnpm install && pnpm lint && pnpm typecheck && pnpm test` passes from a clean
  checkout (once `LEM-001` lands).
- The story is committed as one story-scoped commit and pushed to `origin`.
  Report the commit SHA and the remote branch in the completion summary.

## Engineering standards

- TypeScript strict mode, ESM, Node.js 20+. No `any` in public APIs without a
  written justification.
- Runtime dependencies in `@lemma/core` are limited to schema and parsing
  primitives (`zod`, a small YAML parser). Everything else is a peer dependency
  or an optional subpath.
- Prefer the platform: `node:crypto`, `node:fs/promises`, `AbortSignal`. Do not
  add a utility package for a one-line operation.
- All filesystem writes use the shared atomic-write primitive. All shared mutable
  state uses the shared file lock. No package-local reimplementation.
- Public contracts are versioned and schema-checked. Additive optional fields
  are allowed; removing or retyping a field requires a version bump.
- Errors are typed and machine-readable. A CLI failure never prints a stack trace
  to stdout.
- Tests are deterministic. No network, no wall-clock assertions, no shared
  mutable fixtures. Use the injected clock and entropy providers.

## Security and data handling

- Treat every target as hostile until its URL passes SSRF validation.
- Do not add a tool or check that exploits, brute-forces, submits real
  transactions, creates accounts, or reads another tenant's data.
- Keep secrets out of prompts, fixtures, logs, and commit history. Use synthetic
  values that are clearly fake.
- A suspected live credential is a blocker to escalate, not a finding to copy.
- Evidence is untrusted input too. Validate paths and never execute an artifact.
- A host form answer may contain a secret. Consume it in memory for the single
  request and never return it to the model or persist it.

## Cloud-tier guardrails

- Metering events are the billing source of truth. Emit them from the action that
  consumes the resource, not from a periodic guess.
- A quota failure blocks only the action that exceeds the limit. Preserve
  completed work and report partial billing accurately.
- Resolve tenant identity before any quota, evidence, or job lookup. Never accept
  a tenant id from a request body when a scoped token exists.
- Billing integrations stay behind a feature flag and a kill switch. A provider
  outage must not stop the core harness.
- Do not add pricing or plan names to the open-source core. Commercial policy
  lives in cloud configuration.

## Commands (once `LEM-001` lands)

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:parity          # assay vs lemma golden reports
pnpm test:e2e             # host adapter end-to-end
```
