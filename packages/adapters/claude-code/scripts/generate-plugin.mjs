/**
 * Regenerate the checked-in Claude Code plugin from @lemma/agent templates.
 *
 * Usage (from repo root):
 *   pnpm --filter @lemma/adapters-claude-code build
 *   node packages/adapters/claude-code/scripts/generate-plugin.mjs
 *
 * The parity test (test/claude-code-plugin.test.ts) fails if generated files
 * drift from this output.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "../../..");

let plugin;
try {
  plugin = await import("../dist/index.js");
} catch {
  throw new Error(
    "Build @lemma/adapters-claude-code first: pnpm --filter @lemma/adapters-claude-code build",
  );
}

const pluginRoot = path.join(repoRoot, plugin.CLAUDE_CODE_PLUGIN_DIR);
for (const asset of plugin.buildClaudeCodePluginAssets()) {
  const target = path.join(pluginRoot, asset.relPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, asset.content, "utf8");
  if (asset.mode !== undefined) await chmod(target, asset.mode);
}

const marketplace = path.join(repoRoot, plugin.CLAUDE_CODE_MARKETPLACE_PATH);
await mkdir(path.dirname(marketplace), { recursive: true });
await writeFile(marketplace, plugin.buildClaudeCodeMarketplaceManifest(), "utf8");

process.stdout.write(
  `Generated ${path.relative(repoRoot, pluginRoot)} and ${path.relative(repoRoot, marketplace)}\n`,
);
