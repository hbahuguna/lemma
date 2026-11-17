import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProUnavailableError } from "../../src/index.js";

import { MODEL_API_MODEL_ID, ModelApiUnauthorizedError, createModelApiServer } from "../../../../pro-services/model-api/src/server.ts";
import { assertNonStreamingCompletion, assertStreamingCompletion, createOpenAIChatCompletionsRequest, parseSSE } from "../../../../pro-services/model-api/fixtures/openai-client.ts";

const dirs: string[] = [];
async function mk(prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const licensed = { verification: true };
const apiKey = "test-key-123";

async function readMeteringEvents(sinkAbs: string): Promise<any[]> {
  try {
    const raw = await readFile(sinkAbs, "utf8");
    return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  } catch (e: any) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

describe("LEM-203 TAI-style fine-tuned QA model API", () => {
  it("license gate: unlicensed invocation returns ProUnavailableError", async () => {
    const root = await mk("lemma-modelapi-lic-");
    const srv = await createModelApiServer({
      license: null,
      apiKeys: [apiKey],
      meteringRoot: root,
      meteringSink: ".lemma/metering/events.jsonl",
      runId: "run-lic",
    });
    try {
      const res = await createOpenAIChatCompletionsRequest(srv.baseUrl, { model: MODEL_API_MODEL_ID, messages: [{ role: "user", content: "hi" }] }, { apiKey });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.name).toBe(ProUnavailableError.name);
      expect(body.error.code).toBe("pro_unavailable");
      expect(body.error.message).toContain("Pro");
    } finally {
      await srv.close();
    }
  });

  it("rejects unauthorized requests with typed error before inference (no metering side effects)", async () => {
    const root = await mk("lemma-modelapi-auth-");
    const sink = path.join(root, ".lemma", "metering", "events.jsonl");
    const srv = await createModelApiServer({
      license: licensed,
      apiKeys: [apiKey],
      meteringRoot: root,
      meteringSink: ".lemma/metering/events.jsonl",
      runId: "run-auth",
    });
    try {
      const res = await createOpenAIChatCompletionsRequest(srv.baseUrl, { model: MODEL_API_MODEL_ID, messages: [{ role: "user", content: "secret" }] }, { apiKey: "wrong" });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.name).toBe(ModelApiUnauthorizedError.name);
      expect(body.error.code).toBe("unauthorized");
      expect(body.error.type).toBe("authentication_error");
      // before inference => no metered completion event
      const events = await readMeteringEvents(sink);
      expect(events.length).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it("non-streaming wire conformance (repo-owned OpenAI-compatible client fixture) and metering envelope (LEM-113)", async () => {
    const root = await mk("lemma-modelapi-ns-");
    const sink = path.join(root, ".lemma", "metering", "events.jsonl");
    const srv = await createModelApiServer({
      license: licensed,
      apiKeys: [apiKey],
      meteringRoot: root,
      meteringSink: ".lemma/metering/events.jsonl",
      workspace: "ws-test",
      runId: "run-ns",
      now: () => 1700000000,
    });
    try {
      const res = await createOpenAIChatCompletionsRequest(srv.baseUrl, { model: MODEL_API_MODEL_ID, messages: [{ role: "user", content: "How to test login?" }] }, { apiKey });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      assertNonStreamingCompletion(body);
      expect(body.model).toBe(MODEL_API_MODEL_ID);
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.role).toBe("assistant");
      expect(typeof body.choices[0].message.content).toBe("string");

      const events = await readMeteringEvents(sink);
      expect(events.length).toBeGreaterThan(0);
      const e = events[0];
      expect(e.schema_version).toBeDefined();
      expect(e.event_type).toBe("export_generated");
      expect(e.workspace).toBe("ws-test");
      expect(e.run).toBe("run-ns");
      expect(e.quantity).toBe(1);
      expect(e.unit).toBe("export");
      expect(e.metadata.format).toBe("openai_chat_completion");
      expect(typeof e.idempotency_key).toBe("string");
    } finally {
      await srv.close();
    }
  });

  it("streaming wire conformance (SSE chat.completion.chunk + [DONE]) and metering", async () => {
    const root = await mk("lemma-modelapi-s-");
    const sink = path.join(root, ".lemma", "metering", "events.jsonl");
    const srv = await createModelApiServer({
      license: licensed,
      apiKeys: [apiKey],
      meteringRoot: root,
      meteringSink: ".lemma/metering/events.jsonl",
      workspace: "ws-test",
      runId: "run-s",
    });
    try {
      const res = await createOpenAIChatCompletionsRequest(srv.baseUrl, { model: MODEL_API_MODEL_ID, messages: [{ role: "user", content: "stream please" }], stream: true }, { apiKey });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      const eventsWire = parseSSE(text);
      assertStreamingCompletion(eventsWire as any);
      const chunks = eventsWire.filter((e): e is any => e !== "[DONE]");
      expect(chunks.some((c) => c.model === MODEL_API_MODEL_ID)).toBe(true);

      const metering = await readMeteringEvents(sink);
      expect(metering.length).toBeGreaterThan(0);
      expect(metering[0].metadata.stream).toBe(true);
    } finally {
      await srv.close();
    }
  });
});
