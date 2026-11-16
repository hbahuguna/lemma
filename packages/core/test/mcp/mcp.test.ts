import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MCP_PROTOCOL_REVISION,
  getMcpToolDefinitions,
  handleMcpRequest,
  toolLemmaDemo,
  toolLemmaKnowledge,
  toolLemmaReport,
  toolLemmaSettings,
  toolLemmaStart,
  toolLemmaUpdate,
} from "../../src/mcp/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function isJsonRpcResponse(v: any): v is { jsonrpc: "2.0"; id: any } {
  return v && v.jsonrpc === "2.0" && Object.prototype.hasOwnProperty.call(v, "id");
}

describe("LEM-151 MCP server", () => {
  it("exposes required tools with schemas and handles JSON-RPC framing", async () => {
    const defs = getMcpToolDefinitions();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["lemma_demo", "lemma_knowledge", "lemma_report", "lemma_settings", "lemma_start", "lemma_update"].sort());
    for (const d of defs) {
      expect(d.inputSchema && typeof d.inputSchema === "object").toBe(true);
      expect(typeof d.description).toBe("string");
    }

    const init = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(isJsonRpcResponse(init)).toBe(true);
    expect((init as any).result.protocolVersion).toBe(MCP_PROTOCOL_REVISION);

    const notif = await handleMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    expect(notif).toBeNull();

    const list = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect((list as any).result.tools.map((t: any) => t.name)).toContain("lemma_start");
    expect((list as any).result.tools.map((t: any) => t.name)).toContain("lemma_knowledge");

    const bad = await handleMcpRequest("not-jsonrpc");
    expect((bad as any).error.code).toBe(-32600);
  });

  it("tool handlers work per tool and redact sensitive args/results", async () => {
    const root = await mkdtemp("lemma-mcp-root-");
    tempDirs.push(root);

    const settingsRes = await toolLemmaSettings({
      root,
      action: "set",
      settings: {
        schema_version: "lemma.settings/v1",
        budget: { minutes: 3, maxChecks: 5 },
        focus: { project: "p", url: "https://example.test/?token=supersecret" },
        analytics: { enabled: false, endpoint: "https://a.test/?api_key=supersecret" },
      },
    });
    expect((settingsRes as any).ok).toBe(true);
    expect(JSON.stringify(settingsRes)).not.toContain("supersecret");

    const gotSettings = await toolLemmaSettings({ root, action: "get" });
    expect((gotSettings as any).settings.budget.maxChecks).toBe(5);

    const demoTarget = path.join(root, "demo");
    const demo = await toolLemmaDemo({ target_dir: demoTarget, seed: 7 });
    expect((demo as any).ok).toBe(true);
    expect((demo as any).files).toContain(".lemma-demo");
    expect(await fs.readFile(path.join(demoTarget, ".lemma-demo"), "utf8")).toContain("lemma.demo/v1");

    const knowledge = await toolLemmaKnowledge({ root });
    expect((knowledge as any).ok).toBe(true);
    expect((knowledge as any).knowledge.tools).toContain("lemma_knowledge");

    const status = await toolLemmaUpdate({ root, action: "status" });
    expect((status as any).ok).toBe(true);
    expect((status as any).status).toBeNull();

    // tools/call envelope and HarnessError-shaped error for invalid input
    const callErr = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "lemma_settings", arguments: { root, action: "set", settings: { bad: true } } },
    });
    expect((callErr as any).result.isError).toBe(true);
    const structured = (callErr as any).result.structuredContent;
    expect(structured.ok).toBe(false);
    expect(structured.error).toBeTruthy();
    expect(typeof structured.error.message).toBe("string");
    expect(String(structured.error.message)).not.toContain("\n    at ");
  });

  it("lemma_start is deterministic with seed+clock and produces matching core artifacts", async () => {
    const rootA = await mkdtemp("lemma-mcp-start-a-");
    const rootB = await mkdtemp("lemma-mcp-start-b-");
    tempDirs.push(rootA, rootB);
    const targetA = path.join(rootA, "proj");
    const targetB = path.join(rootB, "proj");
    await fs.mkdir(targetA, { recursive: true });
    await fs.mkdir(targetB, { recursive: true });
    await fs.writeFile(path.join(targetA, "README.md"), "hello\n", "utf8");
    await fs.writeFile(path.join(targetB, "README.md"), "hello\n", "utf8");

    const args = {
      target: ".",
      intent: "Assess release readiness of the target.",
      max_checks: 1,
      seed: 42,
      clock: { mode: "frozen" as const, frozen: "2026-11-16T00:00:00Z" },
    };

    const a = await toolLemmaStart({ ...args, root: targetA });
    const b = await toolLemmaStart({ ...args, root: targetB });
    expect((a as any).ok).toBe(true);
    expect((b as any).ok).toBe(true);

    const ra = (a as any).report as any;
    const rb = (b as any).report as any;
    expect(ra.schema_version).toBe(rb.schema_version);
    expect(ra.status).toBe(rb.status);
    expect(ra.decision).toEqual(rb.decision);
    expect(ra.confidence).toEqual(rb.confidence);
    expect(ra.coverage).toEqual(rb.coverage);
    expect(ra.checks).toEqual(rb.checks);
    expect(ra.findings).toEqual(rb.findings);
    expect(ra.target?.kind).toBe(rb.target?.kind);

    // byte-identical core progress/report artifacts modulo allowed volatile run-specific paths are same-structured here
    const pa = await fs.readFile(path.join(targetA, ".lemma", "progress.json"), "utf8");
    const pb = await fs.readFile(path.join(targetB, ".lemma", "progress.json"), "utf8");
    const ja = JSON.parse(pa);
    const jb = JSON.parse(pb);
    // run_id is generated; compare deterministic state excluding run-unique identifiers/timestamps per volatile contract
    delete ja.run_id; delete jb.run_id;
    delete ja.started_at; delete jb.started_at;
    delete ja.completed_at; delete jb.completed_at;
    delete ja.updated_at; delete jb.updated_at;
    if (ja.options) { delete ja.options.run_id; delete jb.options?.run_id; }
    expect(ja).toEqual(jb);

    const reportViaTool = await toolLemmaReport({ root: targetA });
    expect((reportViaTool as any).ok).toBe(true);
  });

  it("does not import adapter packages (dependency-direction assertion)", async () => {
    const here = path.resolve(__dirname, "../../src/mcp");
    const files = ["tools.ts", "server.ts", "index.ts"];
    for (const f of files) {
      const src = await fs.readFile(path.join(here, f), "utf8");
      expect(src).not.toMatch(/@lemma\/adapters/);
      expect(src).not.toMatch(/packages\/adapters/);
    }
  });
});
