/**
 * Repo-owned OpenAI-compatible client fixture for wire-format conformance.
 * Used by tests to validate non-streaming and streaming chat/completions responses.
 */
export interface OpenAIChatMessage { role: string; content: string }
export interface OpenAIChatCompletionsRequest { model?: string; messages: OpenAIChatMessage[]; stream?: boolean; [k: string]: unknown }

export interface OpenAIChatCompletionChoice {
  index: number;
  message?: { role: string; content: string };
  delta?: { role?: string; content?: string };
  finish_reason: string | null;
}

export interface OpenAIChatCompletion {
  id: string;
  object: "chat.completion" | "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatCompletionChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function assertNonStreamingCompletion(value: any): asserts value is OpenAIChatCompletion {
  if (!value || typeof value !== "object") throw new Error("response must be object");
  if (typeof value.id !== "string" || !value.id) throw new Error("id required");
  if (value.object !== "chat.completion") throw new Error("object must be chat.completion");
  if (typeof value.created !== "number") throw new Error("created must be number");
  if (typeof value.model !== "string" || !value.model) throw new Error("model required");
  if (!Array.isArray(value.choices) || value.choices.length < 1) throw new Error("choices required");
  const c = value.choices[0];
  if (!c || c.index !== 0) throw new Error("choice index 0 required");
  if (!c.message || c.message.role !== "assistant" || typeof c.message.content !== "string") throw new Error("assistant message required");
  if (c.finish_reason !== "stop") throw new Error("finish_reason stop expected");
  if (!value.usage || typeof value.usage.total_tokens !== "number") throw new Error("usage required");
}

export function parseSSE(body: string): Array<OpenAIChatCompletion | "[DONE]"> {
  const events: Array<OpenAIChatCompletion | "[DONE]"> = [];
  const blocks = body.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") { events.push("[DONE]"); continue; }
      events.push(JSON.parse(data));
    }
  }
  return events;
}

export function assertStreamingCompletion(events: Array<OpenAIChatCompletion | "[DONE]">): void {
  if (events.length < 2) throw new Error("expected streaming chunks and [DONE]");
  const done = events[events.length - 1];
  if (done !== "[DONE]") throw new Error("stream must end with [DONE]");
  const chunks = events.slice(0, -1) as OpenAIChatCompletion[];
  if (!chunks.some((c) => c.object === "chat.completion.chunk")) throw new Error("expected chat.completion.chunk");
  const hasAssistant = chunks.some((c) => c.choices?.[0]?.delta?.role === "assistant" || typeof c.choices?.[0]?.delta?.content === "string" || c.choices?.[0]?.finish_reason === "stop");
  if (!hasAssistant) throw new Error("expected assistant delta/finish");
  for (const c of chunks) {
    if (c.object !== "chat.completion.chunk") throw new Error("chunk object must be chat.completion.chunk");
    if (typeof c.id !== "string" || typeof c.created !== "number" || typeof c.model !== "string") throw new Error("chunk envelope invalid");
    if (!Array.isArray(c.choices) || c.choices[0]?.index !== 0) throw new Error("chunk choice invalid");
  }
}

export async function createOpenAIChatCompletionsRequest(baseUrl: string, req: OpenAIChatCompletionsRequest, opts: { apiKey?: string; stream?: boolean } = {}) {
  const body = { ...req, ...(opts.stream != null ? { stream: opts.stream } : {}) };
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res;
}
