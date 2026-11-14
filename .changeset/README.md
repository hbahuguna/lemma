# Changesets

Run `pnpm changeset` to describe a user-visible change. The release flow
(Changesets + npm provenance, see ADR 0002 and release-dry-run CI) consumes the
pending changesets.

Common commands:
- `pnpm changeset` — add a changeset
- `pnpm version-packages` — apply versions/changelogs
- `pnpm publish --dry-run --recursive --no-git-checks` — local manifest/tarball dry-run

See https://github.com/changesets/changesets for the workflow.
