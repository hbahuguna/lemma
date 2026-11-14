# ADR 0002: Package scope, CLI name, release flow, and consumer contracts

- **Status:** Accepted
- **Date:** 2026-11-14
- **Owners:** LEM-009
- **Related:** `docs/architecture.md`, `docs/adr/0001-typescript-monorepo-and-contracts.md`, `BOARD.md` (LEM-001, LEM-003, LEM-009), `.changeset/config.json`, `SECURITY.md`

## Context

`lemma` is moving from bootstrap scaffolding to a publishable OSS core with installable host integrations. Consumers and host adapters need stable package names, a stable CLI binary, explicit public export surfaces, an optional-capability install contract (browser/cloud/host SDKs must never be required), and a repeatable release process with provenance.

## Decisions

### 1) Package scope and CLI binary
- **npm scope:** `@lemma/*` for all public workspace packages.
  - Core/runtime: `@lemma/core`, `@lemma/agent`, `@lemma/cli`
  - Optional capability packages: `@lemma/browser`, `@lemma/cloud`
  - Contracts/support: `@lemma/personas`
  - Host adapters: `@lemma/adapters-opencode`, `@lemma/adapters-claude-code`, `@lemma/adapters-codex`, `@lemma/adapters-antigravity`, `@lemma/adapters-cursor`
- **CLI binary name:** `lemma` (provided by `@lemma/cli`).

### 2) Consumer contracts and exports
- Every public package defines an explicit `exports` map with at least:
  - `"."` → ESM/types entry point
  - `"./package.json"` → package manifest
- Optional capability surfaces are exposed as **optional subpaths** (not required installs):
  - `@lemma/core/browser` — optional browser contract/integration surface (implemented by/with `@lemma/browser`; Playwright remains optional peer)
  - `@lemma/core/cloud` — optional cloud contract/integration surface (implemented by/with `@lemma/cloud`; provider SDKs remain optional peer)
  - `@lemma/browser` and `@lemma/cloud` remain separately installable optional packages.
- Packages publish ESM (`type: module`) for Node.js `>=20` with declaration output in `dist/`.

### 3) Optionality and peer-dependency policy
- `@lemma/core` MUST NOT require Playwright, any host SDK, or cloud/provider SDKs.
- Browser automation dependencies (e.g. Playwright) are **optional peer dependencies** of optional browser surfaces/packages and are loaded dynamically when enabled.
- Host SDKs are dependencies/peers only of the specific adapter packages that target them; never required by core/agent/cli base install.
- Cloud/provider SDKs are optional peers of `@lemma/cloud` and/or cloud subpaths; base install works air-gapped without credentials.

### 4) Semver and release flow
- **Versioning:** SemVer for all published packages. Breaking contract/API changes require a major bump and migration note (per `AGENTS.md`); additive optional fields/exports are minor/patch as appropriate.
- **Release tooling:** **Changesets** (`.changeset/`) for changelog/version management and coordinated releases.
  - `pnpm changeset` records user-visible changes.
  - `pnpm version-packages` (`changeset version`) applies versions/changelogs.
  - CI/release automation publishes with Changesets after verification gates pass.
- **Provenance:** npm publishes use **npm provenance** (`--provenance`) from GitHub Actions OIDC (`id-token: write`) with public registry metadata.
- **Dry-run verification:** CI includes a **publish dry-run** job (`pnpm publish --dry-run --recursive --no-git-checks --provenance` in CI context / local dry-run verification) to validate package manifests, tarball contents, and publishability before release.

## Consequences

- Stable, discoverable package/CLI names for consumers and host installers.
- Explicit export contracts enable safe subpath evolution and optional capability loading.
- Browser/cloud/host integrations remain opt-in without penalizing core/CI installs.
- Changesets + provenance provide auditable, repeatable releases; dry-run catches manifest/export issues early.

## Verification

- ADR and policy docs present (`docs/adr/0002-*`, `SECURITY.md`).
- Public package manifests define required exports/bin and optional browser/cloud subpaths where applicable.
- `.github/workflows/release-dry-run.yml` runs `pnpm publish --dry-run --recursive` (provenance-capable CI job).
- `pnpm publish --dry-run --recursive --no-git-checks` succeeds locally for workspace packages.
