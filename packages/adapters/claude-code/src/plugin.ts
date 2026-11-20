/**
 * Claude Code plugin packaging assets.
 *
 * The command and skill bodies are generated from the shared @lemma/agent
 * templates, so the plugin is a generated artifact rather than a second copy
 * of the product surface. The launcher resolves the CLI at runtime; no plugin
 * file stores a checkout path.
 */
import {
  ASSAY_COMMAND_CATALOG,
  renderAllCatalogCommandTemplates,
  renderLemmaSkillTemplate,
  renderOperationalCommandTemplate,
  type CommandTemplateOptions,
} from "@lemma/agent";
import { OPERATIONAL_COMMAND_TEMPLATE_NAMES, SKILL_TEMPLATE_NAME } from "@lemma/adapters-sdk";

export const CLAUDE_CODE_PLUGIN_NAME = "lemma" as const;
export const CLAUDE_CODE_PLUGIN_VERSION = "0.0.0" as const;
export const CLAUDE_CODE_PLUGIN_DIR = "packages/adapters/claude-code/plugin" as const;
export const CLAUDE_CODE_MARKETPLACE_PATH = ".claude-plugin/marketplace.json" as const;

/** `lemma` is installed by the plugin's `bin/` directory while it is enabled. */
export const CLAUDE_CODE_PLUGIN_TEMPLATE_OPTIONS: CommandTemplateOptions = {
  cli: CLAUDE_CODE_PLUGIN_NAME,
  personasDir: "<personas-dir>",
  stateRoot: ".lemma",
};

export interface ClaudeCodePluginAsset {
  /** Path relative to the plugin root. */
  relPath: string;
  content: string;
  /** POSIX mode for executable assets. */
  mode?: number;
}

const CLI_LAUNCHER = `#!/bin/sh
# Lemma CLI launcher bundled with the Claude Code plugin.
# Resolution happens at runtime; no checkout path is persisted here.
set -eu

if [ -n "\${LEMMA_CLI_BIN:-}" ]; then
  case "$LEMMA_CLI_BIN" in
    *.js|*.mjs) exec node "$LEMMA_CLI_BIN" "$@" ;;
    *) exec "$LEMMA_CLI_BIN" "$@" ;;
  esac
fi

# Resolve this script even when Claude Code puts bin/ on PATH without CLAUDE_PLUGIN_ROOT.
script_path=$0
case "$script_path" in
  */*) ;;
  *) script_path=$(command -v "$script_path" 2>/dev/null || printf '%s' "$script_path") ;;
esac
plugin_root=$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd)
repo_root=$(CDPATH= cd -- "$plugin_root/../../../.." 2>/dev/null && pwd) || repo_root=""

# 1. Inside a lemma checkout (local --plugin-dir or git marketplace install).
if [ -n "$repo_root" ] && [ -f "$repo_root/packages/cli/dist/cli.js" ]; then
  exec node "$repo_root/packages/cli/dist/cli.js" "$@"
fi

# 2. Project-local install of @lemma/cli.
if [ -x "./node_modules/.bin/lemma" ]; then
  exec "./node_modules/.bin/lemma" "$@"
fi

# 3. Published package (available once npm publish is unblocked).
if command -v npx >/dev/null 2>&1; then
  exec npx -y @lemma/cli "$@"
fi

printf '%s\\n' "lemma CLI not found: build @lemma/cli, install @lemma/cli in this project, or set LEMMA_CLI_BIN" >&2
exit 1
`;

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildClaudeCodePluginManifest(): string {
  return stableJson({
    name: CLAUDE_CODE_PLUGIN_NAME,
    displayName: "Lemma Release Confidence",
    version: CLAUDE_CODE_PLUGIN_VERSION,
    description:
      "Deterministic, evidence-backed release confidence: what ran, what did not, what still blocks a ship decision, and why the score is what it is.",
    author: { name: "Lemma" },
    homepage: "https://github.com/hbahuguna/lemma",
    repository: "https://github.com/hbahuguna/lemma",
    license: "MIT",
    keywords: ["testing", "release-confidence", "evidence", "browser-regression"],
  });
}

export function buildClaudeCodePluginMcpConfig(): string {
  return stableJson({
    mcpServers: {
      lemma: {
        command: "sh",
        args: ["${CLAUDE_PLUGIN_ROOT}/bin/lemma", "mcp"],
      },
    },
  });
}

export function buildClaudeCodeMarketplaceManifest(): string {
  return stableJson({
    name: CLAUDE_CODE_PLUGIN_NAME,
    owner: { name: "Lemma" },
    description: "Deterministic release confidence plugin for Claude Code.",
    version: CLAUDE_CODE_PLUGIN_VERSION,
    plugins: [
      {
        name: CLAUDE_CODE_PLUGIN_NAME,
        description: "Evidence-backed release confidence and source-derived browser regression.",
        source: `./${CLAUDE_CODE_PLUGIN_DIR}`,
      },
    ],
  });
}

/**
 * Build every file in the plugin in deterministic order. Used by the checked-in
 * generator and by the parity test that keeps generated files honest.
 */
export function buildClaudeCodePluginAssets(
  options: CommandTemplateOptions = CLAUDE_CODE_PLUGIN_TEMPLATE_OPTIONS,
): ClaudeCodePluginAsset[] {
  const assets: ClaudeCodePluginAsset[] = [
    { relPath: ".claude-plugin/plugin.json", content: buildClaudeCodePluginManifest() },
    { relPath: ".mcp.json", content: buildClaudeCodePluginMcpConfig() },
    { relPath: "bin/lemma", content: CLI_LAUNCHER, mode: 0o755 },
  ];

  for (const command of ASSAY_COMMAND_CATALOG) {
    const rendered = renderAllCatalogCommandTemplates(options, [command])[0];
    if (rendered)
      assets.push({ relPath: `commands/${rendered.name}.md`, content: rendered.markdown });
  }
  for (const name of OPERATIONAL_COMMAND_TEMPLATE_NAMES) {
    const rendered = renderOperationalCommandTemplate(name, options);
    assets.push({ relPath: `commands/${rendered.name}.md`, content: rendered.markdown });
  }
  assets.push({
    relPath: `skills/${SKILL_TEMPLATE_NAME}/SKILL.md`,
    content: renderLemmaSkillTemplate(options),
  });

  return assets;
}
