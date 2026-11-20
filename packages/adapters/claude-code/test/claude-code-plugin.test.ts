import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_MARKETPLACE_PATH,
  CLAUDE_CODE_PLUGIN_DIR,
  buildClaudeCodeMarketplaceManifest,
  buildClaudeCodePluginAssets,
} from "../src/index.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const pluginRoot = path.join(repoRoot, CLAUDE_CODE_PLUGIN_DIR);
const marketplacePath = path.join(repoRoot, CLAUDE_CODE_MARKETPLACE_PATH);

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs, base)));
    else out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out.sort();
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cc-plugin-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-212 Claude Code plugin package", () => {
  it("ships valid plugin and marketplace manifests", async () => {
    const pluginJson = JSON.parse(
      await readFile(path.join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pluginJson.name).toBe("lemma");
    expect(pluginJson.displayName).toBe("Lemma Release Confidence");
    expect(typeof pluginJson.version).toBe("string");
    expect(typeof pluginJson.description).toBe("string");
    expect((pluginJson.author as Record<string, unknown>).name).toBeTruthy();
    expect(pluginJson.license).toBe("MIT");

    const marketplaceJson = JSON.parse(await readFile(marketplacePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(marketplaceJson.name).toBe("lemma");
    expect((marketplaceJson.owner as Record<string, unknown>).name).toBeTruthy();
    const entries = marketplaceJson.plugins as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("lemma");
    expect(entries[0]?.source).toBe(`./${CLAUDE_CODE_PLUGIN_DIR}`);
    expect((await stat(path.join(repoRoot, CLAUDE_CODE_PLUGIN_DIR))).isDirectory()).toBe(true);
    expect(await readFile(marketplacePath, "utf8")).toBe(buildClaudeCodeMarketplaceManifest());
  });

  it("contains no checkout or absolute paths", async () => {
    const files = await listFiles(pluginRoot);
    expect(files.length).toBeGreaterThan(60);
    const absolutePath = /(^|[\s"'(=])((?:\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\|file:\/\/))/;
    for (const rel of files) {
      const content = await readFile(path.join(pluginRoot, rel), "utf8");
      expect(content, rel).not.toMatch(absolutePath);
    }
    expect(await readFile(marketplacePath, "utf8")).not.toMatch(absolutePath);
  });

  it("is byte-for-byte generated from the shared agent templates", async () => {
    const assets = buildClaudeCodePluginAssets();
    const expected = assets.map((a) => a.relPath).sort();
    expect(await listFiles(pluginRoot)).toEqual(expected);

    for (const asset of assets) {
      expect(await readFile(path.join(pluginRoot, asset.relPath), "utf8"), asset.relPath).toBe(
        asset.content,
      );
    }
    const commands = assets.filter((a) => a.relPath.startsWith("commands/"));
    expect(commands).toHaveLength(65);
    for (const name of ["lemma-browser", "lemma-status", "lemma-report"]) {
      expect(await readFile(path.join(pluginRoot, "commands", `${name}.md`), "utf8")).toContain(
        "lemma ",
      );
    }
  });

  it("declares a portable MCP server that launches lemma mcp", async () => {
    const config = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(config.mcpServers.lemma).toBeDefined();
    expect(config.mcpServers.lemma.args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/bin/lemma");
    expect(config.mcpServers.lemma.args.at(-1)).toBe("mcp");

    const launcher = await readFile(path.join(pluginRoot, "bin/lemma"), "utf8");
    expect(launcher).toContain("LEMMA_CLI_BIN");
    expect(launcher).toContain("packages/cli/dist/cli.js");
    expect(launcher).toContain("node_modules/.bin/lemma");
    expect(launcher).toContain("npx -y @lemma/cli");
    expect((await stat(path.join(pluginRoot, "bin/lemma"))).mode & 0o111).not.toBe(0);
  });

  it("launches the resolved CLI with the MCP subcommand", async () => {
    await withTempDir(async (dir) => {
      const fakeCli = path.join(dir, "lemma");
      await writeFile(fakeCli, '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 });
      const { stdout } = await run("sh", [path.join(pluginRoot, "bin/lemma"), "mcp"], {
        cwd: dir,
        env: { ...process.env, LEMMA_CLI_BIN: fakeCli },
      });
      expect(stdout.trim()).toBe("mcp");

      const fakeNodeCli = path.join(dir, "cli.js");
      await writeFile(
        fakeNodeCli,
        'process.stdout.write(process.argv.slice(2).join(" ")+"\\n")\n',
        "utf8",
      );
      const nodeRun = await run("sh", [path.join(pluginRoot, "bin/lemma"), "mcp", "--verbose"], {
        cwd: dir,
        env: { ...process.env, LEMMA_CLI_BIN: fakeNodeCli },
      });
      expect(nodeRun.stdout.trim()).toBe("mcp --verbose");
    });
  });
});
