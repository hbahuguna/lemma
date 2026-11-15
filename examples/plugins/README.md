# Example check plugin (lemma)

`sample-check.ts` is a complete signed-plugin shape for lemma's TypeScript
authoring API, but its exported `PLUGIN.signature` is intentionally empty. An
unsigned plugin is rejected and appears as a **blocked** check (coverage gap);
it is never executed as a passing check.

## Contract

- **Export:** `PLUGIN` is a `CheckPlugin` created with
  `definePlugin(...)` from `@lemma/core` / `@lemma/core/plugins`
  (`definition`, `evaluate`, optional `signature`).
- **Definition:** declares stable `id`, `title`, `domain`, `kind`, `intent`,
  `expected`, `base_weight`, and `requires` in the registry-compatible shape
  used for loading, validation, planning, and signing.
- **Ownership:** the plugin check id must be listed by exactly one persona in
  that persona's frontmatter. Persona ownership (D16), not the definition,
  decides who owns/runs the check. An unowned or multiply-owned plugin check is
  surfaced as a blocked coverage gap (not a pass, not a fatal run failure).
- **Kinds/requirements:** supported plugin kinds are `static` and `plugin`.
  Supported input requirements are `source`, `url`, `markup`, `manifest`, and
  `any`.
- **Entry point:** expose the plugin object from an installed package entry
  point that can be loaded by the registry/host integration. Entry-point
  discovery/loading is environment-dependent; callers may also inject entry
  points programmatically via `buildRegistry({ entryPoints: [...] })`.

`package.json` shows an installable package shape (including a `lemma.checks`
hint). Copy this folder out of the source tree or install it in your
environment before signing/trusting it.

## Signing

Create a project-local trust store with a **synthetic test key** (do not commit
real secrets):

```bash
mkdir -p .lemma/plugins
node <<'NODE'
import { saveTrustKeys, resolvePluginTrustFile } from '@lemma/core/plugins';
saveTrustKeys(resolvePluginTrustFile(process.cwd()), { 'example-key': 'replace-with-a-random-secret' });
NODE
chmod 600 .lemma/plugins/trusted_keys.json
```

Sign the plugin entry point with the same key id and secret:

```bash
node <<'NODE'
import { signPlugin } from '@lemma/core/plugins';
import { DEFINITION } from './sample-check.ts'; // or the installed module path/export
console.log(signPlugin(DEFINITION, 'sample_check:PLUGIN', 'example-key', 'replace-with-a-random-secret'));
NODE
```

Put the returned `hmac-sha256:<key_id>:<digest>` value in `PLUGIN.signature`
(or call `definePlugin({ ...plugin, signature })`). The signature covers the
canonical definition and entry-point value, so changing metadata invalidates it.
The trust store lives under `.lemma/plugins/` (outside source control).

## Ownership

Add the check id to the owning persona's frontmatter before running:

```yaml
checks:
  - example.package_metadata
```

A plugin that is unowned, owned by multiple personas, unsigned, duplicated, or
malformed becomes a **blocked** check with an actionable reason (coverage gap).
The rest of the run continues.

## Evaluator context and refusals

Evaluators receive a bounded `PluginContext` (`check`, `target`, `root`,
`inventory`, `evidence`, `log`) and `await context.saveJson(name, payload,
description?, kind?)` to persist run-evidence and get a run-relative evidence
path for `CheckOutcome.evidence`. Plugin evaluator crashes/misbehavior become
ERROR outcomes (not fatal run failures); invalid/unsafe evidence references are
rejected.

A plugin that reaches a tool or scope boundary should return a blocked outcome
with a blocker instead of a finding:

```ts
import { CheckOutcome, CheckStatus } from "@lemma/core";

const outcome = new CheckOutcome({
  status: CheckStatus.BLOCKED,
  actual: "Refused to submit a synthetic transaction.",
});
outcome.addBlocker(
  "Submit a synthetic checkout transaction.",
  "The run is read-only and has no disposable tenant.",
  ["Provide an approved test tenant and transaction budget."],
);
return outcome;
```

Blocked checks carry exactly one structured blocker and no findings; they are
recorded as coverage gaps (never a pass).
