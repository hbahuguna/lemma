# Assay to lemma migration guide

This guide documents how to migrate from `assay` (`quality-harness`) to `lemma`
and how to move existing local state from `.harness/` to `.lemma/`.

`lemma` is the TypeScript successor to assay. It preserves the core release
confidence model (fixed five-phase workflow, evidence-backed findings, explainable
confidence scoring, fail-closed behavior) while changing packaging, host
integration, and state-root conventions.

## Key differences

- **Product/runtime:** lemma is a TypeScript/ESM monorepo (`packages/*`) with a
  machine-first CLI (`lemma`), host-neutral agent core, and adapter packages.
- **State root:** lemma stores run state/evidence under **`.lemma/`** (not
  `.harness/`).
- **Ignore files:** source scoping supports canonical **`.lemmaignore`** and also
  accepts legacy **`.harnessignore`** for compatibility.
- **Host integrations:** adapter assets are installed per host via
  `lemma install <host>` (OpenCode, Claude Code, Codex, Antigravity, Cursor).
  Some host runtime surfaces remain provisional/unverified and must degrade
  honestly.
- **Contracts:** report/state/evidence contracts are versioned and schema-backed
  in lemma; some schema identifiers remain `quality-harness.*` for compatibility
  during migration.

## State migration

### What moves

Primary local state is stored under the assay state root:

- `.harness/progress.json`
- `.harness/history.json`
- `.harness/events.jsonl`
- `.harness/KILL` (if present)
- `.harness/evidence/<run_id>/...`
- other local state artifacts (suppressions, plugin trust/config state, etc.)

In lemma, equivalent state lives under `.lemma/`.

### State shim

Lemma includes an explicit **read shim** for legacy state:

- When `.lemma/` progress/history/kill state is absent, lemma can read legacy
  `.harness/` state for compatible read operations (e.g. `status`, `report`,
  history inspection) so existing runs remain inspectable.
- New writes continue to target `.lemma/`.

This shim is intended for migration/compatibility. You should still migrate
state to `.lemma/` for normal operation.

## Migration command

Use the CLI migration command to copy legacy state into `.lemma/`:

```bash
# Preview (no writes)
lemma migrate-state --root . --dry-run

# Migrate legacy .harness/ -> .lemma/
lemma migrate-state --root .

# Overwrite existing .lemma/ state if needed (use with care)
lemma migrate-state --root . --force
```

Behavior notes:
- Source defaults to `.harness/`, destination to `.lemma/` under `--root`.
- Fails if legacy source is missing.
- Refuses to overwrite an existing destination unless `--force` is set.
- Emits JSON to stdout describing planned/copied paths and status.

## Manual migration (if needed)

If you prefer a manual copy, stop any active runs first, then copy the directory:

```bash
cp -R .harness .lemma
```

After migration, verify state and evidence:

```bash
lemma status --root .
lemma report --root .
lemma verify-evidence --run-id <run_id> --root .
```

## Caveats

- Migrating state does not change evidence contents or historical hashes; verify
  evidence/manifests after migration if integrity matters.
- If both `.lemma/` and `.harness/` exist, lemma prefers `.lemma/` for reads and
  writes. Use `migrate-state --force` only when you intentionally want to replace
  `.lemma/` contents.
- Assay command names/flags and host plugin surfaces are not all identical in
  lemma; consult `docs/getting-started.md`, `docs/cli-and-agent.md`, and
  `docs/adapters.md`.
- Some host adapters and runtime integrations are provisional/unverified; treat
  declared capability limitations as authoritative.
