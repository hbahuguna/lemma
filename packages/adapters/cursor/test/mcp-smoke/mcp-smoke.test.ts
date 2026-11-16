import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  callLemmaMcpTool,
  createCursorHost,
  getLemmaMcpProtocolRevision,
  initializeLemmaMcpSession,
  listLemmaMcpTools,
} from "../../src/index.js";

describe("LEM-151 Cursor adapter native MCP smoke", () => {
  it("can talk to the native lemma MCP server handlers via adapter integration", async () => {
    const host = createCursorHost();
    expect(host.id).toBe("cursor");

    const init = await initializeLemmaMcpSession() as any;
    expect(init.result.protocolVersion).toBe(getLemmaMcpProtocolRevision());

    const tools = listLemmaMcpTools().map((t: any) => t.name);
    expect(tools).toContain("lemma_start");
    expect(tools).toContain("lemma_update");
    expect(tools).toContain("lemma_report");
    expect(tools).toContain("lemma_settings");
    expect(tools).toContain("lemma_demo");
    expect(tools).toContain("lemma_knowledge");

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-cursor-mcp-"));
    try {
      const knowledge = await callLemmaMcpTool("lemma_knowledge", { root: tmp });
      expect(knowledge.ok).toBe(true);
      expect((knowledge.result as any).ok).toBe(true);
      expect((knowledge.result as any).knowledge.tools).toContain("lemma_report");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
