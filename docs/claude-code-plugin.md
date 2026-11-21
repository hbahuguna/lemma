# Claude Code plugin

Lemma ships as a real Claude Code plugin (commands, a skill, an MCP server, and
a bundled CLI launcher), not just loose files under `.claude/`. The plugin files
live at `packages/adapters/claude-code/plugin/`; the marketplace catalog lives
at the repository root in `.claude-plugin/marketplace.json`.

The plugin is generated from the same `@lemma/agent` templates used by every
other host. To regenerate after a template change:

```bash
pnpm --filter @lemma/adapters-claude-code build
node packages/adapters/claude-code/scripts/generate-plugin.mjs
```

`packages/adapters/claude-code/test/claude-code-plugin.test.ts` fails if the
checked-in files drift from the generator.

## Prerequisites

1. Claude Code v2.1.281 or later (`claude --version`). Older versions can load
   the commands but will not validate or start the plugin MCP server.
2. Node.js 20 or later and a built CLI:

   ```bash
   cd /path/to/lemma
   pnpm install
   pnpm build
   ```

   The bundled `bin/lemma` launcher finds `packages/cli/dist/cli.js` relative to
   the plugin, so no global `lemma` on `PATH` is required.

## Install locally (fastest)

Load the plugin directly from the checkout:

```bash
claude --plugin-dir /path/to/lemma/packages/adapters/claude-code/plugin
```

In the session, run `/reload-plugins` (or restart Claude Code) and check
`/plugin` → Installed. Commands are namespaced with the plugin name, for
example:

- `/lemma:lemma-browser https://testradius.dev` — headed, source-derived browser regression
- `/lemma:lemma-status` — persisted run state
- `/lemma:lemma-report` — last JSON report summary
- `/lemma:lemma` — general assessment

Use `/lemma:<command>` for all 60 catalog commands plus the five operational
commands. Claude Code prefixes every plugin component with `lemma:`.

## Plan-first reports

Every command is plan-first. The command template makes the agent create and
show an intent-specific plan before execution, then execute once, then report
the plan with per-scenario results:

```bash
# Browser command: comprehensive browser plan, then headed crawl
lemma plan --target https://example.test --intent "Lemma browser assessment" --command browser
lemma browser https://example.test --crawl --max-pages 80 --timeout-ms 120000

# Security command with URL: comprehensive security plan, then bounded runtime evidence
lemma plan --target https://example.test --intent "Lemma security assessment" --command security
lemma browser https://example.test --no-crawl --check browser.security --check browser.links
lemma run --target . --no-browser --personas-dir ./personas --intent "Lemma security assessment"
```

`/lemma:lemma-browser <URL>` remains the full headed crawl/interaction regression.
`/lemma:lemma-security <URL>` does **not** run that regression: browser evidence is
limited to the supplied landing page's security/link checks, and route or
interaction coverage is an explicit gap unless `/lemma-browser` is requested
separately. The final JSON contains `test_plan` with `title`, `objective`,
`scenarios`, per-scenario `result` (status, linked checks, evidence, findings,
gap reason), and `summary`. Blocked, skipped, errored, and unlinked scenarios
are reported as coverage gaps, never passes. The final human report must show
the plan first and then the result table from `test_plan`.

The `bin/` launcher is a Claude Code CLI feature; Claude.ai and Cowork do not
install plugins that contain an executable `bin/` directory. Those hosts can
use the legacy loose-file install with an explicitly configured CLI instead.

## Install locally as a marketplace

This is closer to how other users will install it and enables `claude plugin`
management commands:

```bash
# From any directory
claude plugin marketplace add /path/to/lemma
claude plugin install lemma@lemma
claude plugin list
```

The marketplace entry uses a relative source
(`./packages/adapters/claude-code/plugin`), so no plugin file contains a
checkout path. To update after changing templates, rebuild and regenerate, then
run `/reload-plugins` (or `claude plugin update lemma@lemma`).

## MCP server

The plugin declares `.mcp.json`:

```json
{
  "mcpServers": {
    "lemma": { "command": "sh", "args": ["${CLAUDE_PLUGIN_ROOT}/bin/lemma", "mcp"] }
  }
}
```

`lemma mcp` is a real CLI subcommand backed by `@lemma/core/mcp`. It speaks
JSON-RPC over stdio (`initialize`, `tools/list`, `tools/call`, `ping`). Tools
appear in Claude Code as `mcp__plugin_lemma_lemma__<tool>`:

- `lemma_start`, `lemma_update`, `lemma_report`, `lemma_settings`,
  `lemma_demo`, `lemma_knowledge`

stdout is protocol-only; human progress and warnings go to stderr. If the MCP
server does not appear, check `/plugin` → Errors and run:

```bash
claude plugin validate /path/to/lemma/packages/adapters/claude-code/plugin
```

## CLI resolution order

`bin/lemma` never stores an absolute path. It resolves at runtime in this order:

1. `LEMMA_CLI_BIN` — explicit path to an executable (a `.js`/`.mjs` value is run with `node`).
2. `<plugin>/../../../..` + `packages/cli/dist/cli.js` — a local checkout or a
   git-installed marketplace that still has the build.
3. `./node_modules/.bin/lemma` — a project-local `@lemma/cli` install.
4. `npx -y @lemma/cli` — the published package, once publishing is unblocked
   (see the npm credentials blocker in `BOARD.md`).

To point at a specific build without modifying the plugin:

```bash
export LEMMA_CLI_BIN=/path/to/lemma/packages/cli/dist/cli.js
```

## Capability notes

The adapter manifest stays honest: Claude Code declares native forms,
background tasks, and worktrees as unavailable rather than emulating them.
Missing capabilities are recorded as limitations/coverage gaps, never as
passes. The plugin never asks for or persists raw tokens, cookies, or
credentials.

## Legacy loose-file install

`lemma install claude-code --dir .` still writes `.claude/commands/lemma-*.md`
and `.claude/skills/lemma/SKILL.md` for users who cannot use plugins. It is not
a plugin and does not provide the MCP server. Prefer the plugin above.
