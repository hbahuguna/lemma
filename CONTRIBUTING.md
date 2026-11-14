# Contributing to lemma

## Prerequisites

- Node.js 20 or newer (22 is the primary development version).
- pnpm 11 (`corepack enable` is the recommended way to get the pinned version).

## Setup

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

A clean checkout must pass all five commands before a change is reviewable.

## Working agreement

1. Read `AGENTS.md` first. It defines the invariants that no change may weaken.
2. Claim exactly one task from `BOARD.md`. State the acceptance test up front.
3. Keep `@lemma/core` free of host SDKs, CLI frameworks, Playwright, and cloud
   clients. Optional capability belongs behind a subpath export or peer
   dependency.
4. Add or update a test for every behavior change. A blocked check is a
   coverage gap, never a pass.
5. Never commit real credentials, cookies, tokens, or private keys. Use
   obviously synthetic fixtures.
6. Keep `assay` as the behavioral oracle until `LEM-139`. An intentional
   divergence needs an ADR and a `BOARD.md` Decision Log entry.

## Changesets

User-visible changes to a published package require a changeset:

```bash
pnpm changeset
```

Private workspace packages are versioned by the release task (`LEM-134`).

## Commits

One story-scoped commit per board task. The commit message names the task id,
for example `feat(core): add atomic state primitives (LEM-010)`.
