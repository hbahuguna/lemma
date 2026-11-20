import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { coreCommandSpecs, createCommandRegistry, main, type CliIO } from "../src/index.js";
import { MCP_PROTOCOL_REVISION } from "@lemma/core";

interface JsonRpcLine {
  jsonrpc: string;
  id: number | null;
  result?: { protocolVersion?: string; tools?: Array<{ name: string }> };
  error?: { code: number };
}

function makeIo(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) }, stdout, stderr };
}

describe("LEM-211 lemma mcp entrypoint", () => {
  it("is registered as a first-class CLI command", () => {
    const specs = coreCommandSpecs();
    const mcp = specs.find((s) => s.name === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp?.description).toContain("stdio");
    expect(createCommandRegistry(specs).get("mcp")).toBe(mcp);
  });

  it("serves JSON-RPC only on stdout and does not print a second report", async () => {
    const input = new PassThrough();
    const protocol: string[] = [];
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      protocol.push(String(chunk));
      return true;
    });

    try {
      Object.defineProperty(process, "stdin", { configurable: true, value: input });
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
      );
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
      );
      input.end();

      const { io, stdout, stderr } = makeIo();
      const code = await main(["mcp"], io);

      expect(code).toBe(0);
      expect(stdout).toEqual([]);
      expect(stderr.join("")).toContain("lemma MCP server started");
      const lines = protocol
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line): JsonRpcLine => JSON.parse(line) as JsonRpcLine);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: MCP_PROTOCOL_REVISION },
      });
      const names = lines[1]?.result?.tools?.map((tool) => tool.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining([
          "lemma_start",
          "lemma_update",
          "lemma_report",
          "lemma_settings",
          "lemma_demo",
          "lemma_knowledge",
        ]),
      );
    } finally {
      writeSpy.mockRestore();
      if (stdinDescriptor) Object.defineProperty(process, "stdin", stdinDescriptor);
      input.destroy();
    }
  });
});
