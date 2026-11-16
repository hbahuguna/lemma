# LEM-130 Dependency and Supply-Chain Audit

- Generated: 2026-11-16T11:38:26.290Z
- Result: PASS
- Checks: 12/12 passed
- Risks noted: 1

## Checks

| Check | Status | Details |
| --- | --- | --- |
| `lockfile.committed` | PASS | {"path":"pnpm-lock.yaml","detail":"pnpm-lock.yaml is committed"} |
| `root.packageManager.pinned` | PASS | {"value":"pnpm@11.15.1"} |
| `root.engines.node` | PASS | {"value":{"node":">=20"}} |
| `npmrc.present` | PASS | {"path":".npmrc","detail":["engine-strict=true","prefer-workspace-packages=true"]} |
| `ci.frozen-lockfile` | PASS | {"path":".github/workflows/ci.yml"} |
| `release-dry-run.frozen-lockfile` | PASS | {"path":".github/workflows/release-dry-run.yml"} |
| `release-dry-run.provenance` | PASS | {"path":".github/workflows/release-dry-run.yml"} |
| `manifests.no-git-or-tarball-deps` | PASS | {"count":0,"issues":[]} |
| `publishable.metadata-provenance` | PASS | {"publishableCount":12,"issueCount":0,"issues":[]} |
| `core.runtime-deps-constrained` | PASS | {"dependencies":["zod"],"forbidden":[],"policy":"runtime dependencies limited to schema/parsing primitives; no host SDKs (zod allowed)"} |
| `core.no-host-sdk-runtime-deps` | PASS | {"dependencies":["zod"]} |
| `lockfile.no-git-tarball-protocols` | PASS | {"detail":"scanned for git+ssh/git+https/github:/tarball: tokens"} |

## Risks / Notes

- **ci.workflow.structure** (medium, `.github/workflows/ci.yml`): CI workflow appears structurally malformed/duplicated (multiple steps blocks observed around verify/state-primitives jobs); frozen-lockfile checks passed textually but workflow execution should be validated by CI repair task (LEM-132 scope).

## Scope

- Audited workspace manifests, lockfile presence/protocol hints, .npmrc, CI/release install+provenance posture, and publish metadata.
- No dependency upgrades were performed; this is a posture audit with deterministic checks and recorded evidence.
