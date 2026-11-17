import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SCOPE_READ, SCOPE_RUN } from "@lemma/cloud/auth";
import { ProUnavailableError } from "../../src/index.js";

import { createReportsApiServer } from "../../../../pro-services/reports-api/src/server.ts";
import { assertCreateResponse, assertGetResponse, getReport, postReport } from "../../../../pro-services/reports-api/fixtures/client.ts";

const dirs: string[] = [];
async function mk(prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const licensed = { verification: true };

async function readMeteringEvents(root: string): Promise<any[]> {
  const sink = path.join(root, ".lemma", "metering", "events.jsonl");
  try {
    const raw = await readFile(sink, "utf8");
    return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  } catch (e: any) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

async function waitForCompleted(baseUrl: string, id: string, apiKey: string, timeoutMs = 5000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await getReport(baseUrl, id, { apiKey });
    const body = await res.json();
    if (res.status === 200 && (body.status === "completed" || body.status === "failed" || body.status === "cancelled")) return body;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("timeout waiting for report completion");
}

describe("LEM-204 Test Reports REST API", () => {
  it("license gate: unlicensed invocation returns ProUnavailableError", async () => {
    const root = await mk("lemma-reports-lic-");
    const srv = await createReportsApiServer({ root, license: null });
    try {
      const res = await postReport(srv.baseUrl, { target: "https://example.com" }, { apiKey: "any" });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.name).toBe(ProUnavailableError.name);
      expect(body.error.code).toBe("pro_unavailable");
    } finally {
      await srv.close();
    }
  });

  it("wire conformance, async queue/status, auth (scoped-key), metering, and report retrieval by owning tenant", async () => {
    const root = await mk("lemma-reports-wire-");
    const srv = await createReportsApiServer({ root, license: licensed });
    try {
      const ws = srv.authStore.createWorkspace("tenant-a", "ws-a");
      const key = srv.authStore.createKey(ws.id, [SCOPE_RUN, SCOPE_READ], "test", null);

      const createRes = await postReport(srv.baseUrl, { target: "https://example.test/app", intent: "smoke" }, { apiKey: key.secret });
      expect(createRes.status).toBe(202);
      const created = await createRes.json();
      assertCreateResponse(created);
      expect(created.workspace_id).toBe("ws-a");
      expect(["queued", "running", "completed"]).toContain(created.status);

      const final = await waitForCompleted(srv.baseUrl, created.id, key.secret);
      assertGetResponse(final);
      expect(final.status).toBe("completed");
      expect(final.workspace_id).toBe("ws-a");
      expect(final.report && typeof final.report === "object").toBe(true);
      expect(final.report.job_id).toBe(created.id);

      const events = await readMeteringEvents(root);
      expect(events.length).toBeGreaterThanOrEqual(2); // POST + GET metered
      expect(events.every((e) => e.workspace === "ws-a")).toBe(true);
      expect(events.some((e) => e.metadata?.format === "reports_api")).toBe(true);
      expect(events.every((e) => typeof e.schema_version === "string" && typeof e.event_type === "string")).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("auth rejection and tenant isolation (no cross-tenant leakage)", async () => {
    const root = await mk("lemma-reports-tenant-");
    const srv = await createReportsApiServer({ root, license: licensed });
    try {
      const wsA = srv.authStore.createWorkspace("a", "ws-a");
      const wsB = srv.authStore.createWorkspace("b", "ws-b");
      const keyA = srv.authStore.createKey(wsA.id, [SCOPE_RUN, SCOPE_READ], "a", null);
      const keyB = srv.authStore.createKey(wsB.id, [SCOPE_RUN, SCOPE_READ], "b", null);

      // auth rejection
      const noAuth = await postReport(srv.baseUrl, { target: "https://example.com" });
      expect(noAuth.status).toBe(401);
      const bad = await getReport(srv.baseUrl, "missing", { apiKey: "qh_bad.secret" });
      expect([401, 404]).toContain(bad.status); // malformed/unknown key rejected by scoped-key auth

      const createdRes = await postReport(srv.baseUrl, { target: "https://tenant-a.example" }, { apiKey: keyA.secret });
      const created = await createdRes.json();
      await waitForCompleted(srv.baseUrl, created.id, keyA.secret);

      // tenant isolation: other tenant cannot retrieve report and gets 404 (no existence leak)
      const cross = await getReport(srv.baseUrl, created.id, { apiKey: keyB.secret });
      expect(cross.status).toBe(404);
      const crossBody = await cross.json();
      expect(crossBody.error.code).toBe("not_found");
      expect(JSON.stringify(crossBody)).not.toContain("tenant-a");
      expect(JSON.stringify(crossBody)).not.toContain(keyA.secret);
    } finally {
      await srv.close();
    }
  });

  it("quota enforcement on every request", async () => {
    const root = await mk("lemma-reports-quota-");
    // very small quota: 1 run total so second POST is rejected
    const srv = await createReportsApiServer({
      root,
      license: licensed,
      quotaPlan: { id: "tiny", limits: { runs: { hard: 1 }, checks: { hard: 100 } } },
    });
    try {
      const ws = srv.authStore.createWorkspace("q", "ws-q");
      const key = srv.authStore.createKey(ws.id, [SCOPE_RUN, SCOPE_READ], "q", null);

      const first = await postReport(srv.baseUrl, { target: "https://a.example" }, { apiKey: key.secret });
      expect(first.status).toBe(202);

      const second = await postReport(srv.baseUrl, { target: "https://b.example" }, { apiKey: key.secret });
      expect(second.status).toBe(429);
      const body = await second.json();
      expect(body.error.code).toBe("quota_exceeded");
    } finally {
      await srv.close();
    }
  });
});
