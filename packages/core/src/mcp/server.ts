import readline from "node:readline";

import { redactUnknown } from "../redaction.js";
import { MCP_TOOL_HANDLERS, getMcpToolDefinitions, toErrorResult } from "./tools.js";

export const MCP_PROTOCOL_REVISION = "2025-06-18" as const;

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function writeStdoutJson(obj: unknown): void {
  // JSON-RPC only on stdout
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data: redactUnknown(data) }) },
  };
}

export async function handleMcpRequest(req: unknown): Promise<JsonRpcResponse | null> {
  if (!isRecord(req)) return jsonRpcError(null, -32600, "Invalid Request");
  const id = (req.id ?? null) as JsonRpcId;
  const method = typeof req.method === "string" ? req.method : "";
  const params = req.params;

  if (!method) return jsonRpcError(id, -32600, "Invalid Request");

  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_REVISION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lemma-mcp", version: "0.0.0" },
        },
      };
    }
    if (method === "notifications/initialized") {
      return null; // notification
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: getMcpToolDefinitions() } };
    }
    if (method === "tools/call") {
      const p = isRecord(params) ? params : {};
      const name = typeof p.name === "string" ? p.name : "";
      const args = p.arguments ?? {};
      const handler = MCP_TOOL_HANDLERS[name];
      if (!handler) {
        return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
      }
      const out = await handler(args);
      // MCP tool result envelope
      if (isRecord(out) && out.ok === false && isRecord(out.error)) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(redactUnknown(out)) }],
            structuredContent: redactUnknown(out),
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(redactUnknown(out)) }],
          structuredContent: redactUnknown(out),
        },
      };
    }
    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    const shaped = toErrorResult(err);
    return jsonRpcError(id, -32000, "Tool execution failed", shaped);
  }
}

export async function serveStdioMcp(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      writeStdoutJson(jsonRpcError(null, -32700, "Parse error"));
      continue;
    }
    const res = await handleMcpRequest(msg);
    if (res) writeStdoutJson(res);
  }
}
