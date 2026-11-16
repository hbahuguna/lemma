import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startFeedbackService } from "../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop()!;
    try { await fn(); } catch { /* ignore */ }
  }
});

describe("LEM-169 feedback-service integration", () => {
  it("is off by default and must be explicitly enabled", async () => {
    await expect(startFeedbackService({} as any)).rejects.toThrow(/off by default/i);
    await expect(startFeedbackService({ enabled: false } as any)).rejects.toThrow(/explicitly enabled/i);
  });

  it("issues branded, scoped, expiring invitation links and ingests redacted responses (idempotent)", async () => {
    const root = await mkdtemp("lemma-fb-svc-");
    cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));

    const svc = await startFeedbackService({ enabled: true, root, port: 0, host: "127.0.0.1", brand: "lemma" });
    cleanups.push(async () => svc.close());
    const port = (svc.server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;

    const createRes = await fetch(`${base}/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-svc-1", scope: { findings: ["F-1"] }, reviewers: [{ id: "rev-1" }], ttlMs: 60_000 }),
    });
    expect(createRes.status).toBe(201);
    const created: any = await createRes.json();
    expect(created.invitations[0].brand).toBe("lemma");
    expect(created.invitations[0].url).toContain("/review/");
    expect(created.invitations[0].url).toContain("token=");

    const token = new URL(created.invitations[0].url).searchParams.get("token")!;
    const requestId = created.request.request_id;

    const response = {
      schema_version: "lemma.feedback.response/v1",
      request_id: requestId,
      response_id: "resp-svc-1",
      reviewer: { id: "rev-1" },
      submitted_at: "2026-11-16T00:00:10Z",
      items: [{ target: { kind: "finding", id: "F-1" }, comment: "secret=sk-SECRET12345678901234567890" }],
    };

    const ingest1 = await fetch(`${base}/requests/${encodeURIComponent(requestId)}/responses?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(response),
    });
    expect(ingest1.status).toBe(201);
    const r1: any = await ingest1.json();
    expect(r1.idempotent).toBe(false);

    const ingest2 = await fetch(`${base}/requests/${encodeURIComponent(requestId)}/responses?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(response),
    });
    expect(ingest2.status).toBe(200);
    const r2: any = await ingest2.json();
    expect(r2.idempotent).toBe(true);

    // persisted and redacted
    const attachmentPath = r1.attached[0].path;
    const raw = await fs.readFile(attachmentPath, "utf8");
    expect(raw).not.toContain("SECRET12345678901234567890");
    expect(raw).not.toContain(token); // token never logged/persisted
  });
});
