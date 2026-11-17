import http from "node:http";
import { randomUUID } from "node:crypto";

import { MeteringEmitter } from "@lemma/cloud/metering";
import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "@lemma/pro/entitlement";

export const MODEL_API_VERSION = "v1" as const;
export const MODEL_API_MODEL_ID = "lemma-qa-ft-v1" as const;
export const MODEL_API_BASE_PATH = "/v1/chat/completions" as const;

export class ModelApiUnauthorizedError extends Error {
  readonly code = "unauthorized" as const;
  readonly status = 401 as const;
  constructor(message = "Unauthorized: valid API credentials are required before inference.") {
    super(message);
    this.name = "ModelApiUnauthorizedError";
  }
}

export class ModelApiBadRequestError extends Error {
  readonly code = "bad_request" as const;
  readonly status = 400 as const;
  constructor(message = "Bad request") {
    super(message);
    this.name = "ModelApiBadRequestError";
  }
}

export interface ModelApiServerOptions {
  host?: string;
  port?: number;
  license?: ProLicenseContext | null;
  /** required bearer tokens / API keys; when non-empty, requests must match */
  apiKeys?: string[];
  /** metering sink path (LEM-113 envelope). defaults to .lemma/metering/events.jsonl under cwd */
  meteringSink?: string;
  meteringRoot?: string;
  workspace?: string;
  runId?: string;
  /** injectable clock for deterministic tests */
  now?: () => number;
}

export interface ModelApiServerHandle {
  server: http.Server;
  baseUrl: string;
  close(): Promise<void>;
  options: Required<Pick<ModelApiServerOptions, "meteringSink" | "meteringRoot" | "workspace" | "runId">> & { modelId: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(data);
}

function getAuthToken(req: http.IncomingMessage): string | null {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  const raw = Array.isArray(h) ? h[0] : h;
  if (typeof raw === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
    if (m && m[1]) return m[1].trim();
  }
  const k = req.headers["x-api-key"];
  if (typeof k === "string" && k.trim()) return k.trim();
  if (Array.isArray(k) && k[0]) return String(k[0]).trim();
  return null;
}

function buildAssistantContent(messages: any[]): string {
  const lastUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m && m.role === "user");
  const prompt = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
  // Deterministic QA-style response. Never claims to replace human review (enforced by policy/README; response stays factual/helpful).
  return `Lemma QA (fine-tuned model ${MODEL_API_MODEL_ID}) response: ${prompt ? `I can help analyze: ${prompt.slice(0, 500)}` : "How can I assist with your QA question?"}`;
}

function makeCompletion(id: string, model: string, content: string, created: number, stream: boolean) {
  const base = {
    id,
    object: stream ? "chat.completion.chunk" : "chat.completion",
    created,
    model,
    choices: [
      stream
        ? { index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }
        : { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
  } as any;
  if (!stream) {
    base.usage = { prompt_tokens: 0, completion_tokens: Math.max(1, content.split(/\s+/).filter(Boolean).length), total_tokens: Math.max(1, content.split(/\s+/).filter(Boolean).length) };
  }
  return base;
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new ModelApiBadRequestError("Invalid JSON body"); }
}

export async function createModelApiServer(opts: ModelApiServerOptions = {}): Promise<ModelApiServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const apiKeys = Array.isArray(opts.apiKeys) ? opts.apiKeys.filter((k) => typeof k === "string" && k.length > 0) : [];
  const meteringRoot = opts.meteringRoot ?? process.cwd();
  const meteringSink = opts.meteringSink ?? ".lemma/metering/events.jsonl";
  const workspace = opts.workspace ?? "local";
  const runId = opts.runId ?? `model-api-${Date.now()}`;
  const nowFn = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      if (req.method !== "POST" || url.pathname !== MODEL_API_BASE_PATH) {
        sendJson(res, 404, { error: { message: "Not found", type: "invalid_request_error", code: "not_found" } });
        return;
      }

      // Unlicensed invocation returns ProUnavailableError (before auth/inference work is served as pro capability)
      if (!isProLicensed(opts.license ?? null)) {
        const err = new ProUnavailableError("fine-tuned QA model API");
        sendJson(res, 403, { error: { message: err.message, type: "pro_unavailable", code: err.errorCode || "pro_unavailable", name: err.name } });
        return;
      }

      // Unauthorized rejected with typed error before inference
      const token = getAuthToken(req);
      if (apiKeys.length > 0) {
        if (!token || !apiKeys.includes(token)) {
          const err = new ModelApiUnauthorizedError();
          sendJson(res, err.status, { error: { message: err.message, type: "authentication_error", code: err.code, name: err.name } });
          return;
        }
      } else if (!token) {
        const err = new ModelApiUnauthorizedError();
        sendJson(res, err.status, { error: { message: err.message, type: "authentication_error", code: err.code, name: err.name } });
        return;
      }

      const body = await readBody(req);
      const messages = Array.isArray(body?.messages) ? body.messages : null;
      if (!messages) {
        throw new ModelApiBadRequestError("messages array is required");
      }
      const stream = body?.stream === true;
      const model = typeof body?.model === "string" && body.model ? body.model : MODEL_API_MODEL_ID;
      const id = `chatcmpl-${randomUUID()}`;
      const created = nowFn();
      const content = buildAssistantContent(messages);

      // Meter through existing metering envelope (LEM-113) per request/completion
      const emitter = new MeteringEmitter(meteringRoot, runId, { workspace, sink: meteringSink, source: "pro:model-api" });
      emitter.emit("export_generated", 1, "export", {
        metadata: { format: "openai_chat_completion", model, stream },
        idempotency_key: `${runId}:chat_completion:${id}`,
      });

      if (stream) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.setHeader("cache-control", "no-cache, no-transform");
        res.setHeader("connection", "keep-alive");
        // role chunk
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        // content chunk
        res.write(`data: ${JSON.stringify(makeCompletion(id, model, content, created, true))}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      sendJson(res, 200, makeCompletion(id, model, content, created, false));
    } catch (e: any) {
      if (e instanceof ModelApiBadRequestError) {
        sendJson(res, e.status, { error: { message: e.message, type: "invalid_request_error", code: e.code, name: e.name } });
        return;
      }
      if (e instanceof ModelApiUnauthorizedError) {
        sendJson(res, e.status, { error: { message: e.message, type: "authentication_error", code: e.code, name: e.name } });
        return;
      }
      if (e instanceof ProUnavailableError) {
        sendJson(res, 403, { error: { message: e.message, type: "pro_unavailable", code: (e as any).errorCode || "pro_unavailable", name: e.name } });
        return;
      }
      sendJson(res, 500, { error: { message: "Internal server error", type: "server_error", code: "internal_error" } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    baseUrl: `http://${host}:${actualPort}`,
    options: { meteringSink, meteringRoot, workspace, runId, modelId: MODEL_API_MODEL_ID },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
