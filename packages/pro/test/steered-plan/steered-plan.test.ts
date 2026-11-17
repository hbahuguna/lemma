import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore, startDashboard } from "@lemma/core";
import {
  ProUnavailableError,
  STEERED_PLAN_SCHEMA_VERSION,
  SteeredPlanStore,
  createDefaultSteeredPlan,
  handlePlanRoute,
  processUpload,
  steeredPlanSchema,
  validateSteeredPlan,
} from "../../src/index.js";

const dirs: string[] = [];
async function mk(prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

function request(urlStr: string, opts: { method?: string; headers?: Record<string,string>; body?: any } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({ method: opts.method || "GET", hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) } }, (res) => {
      let data = ""; res.setEncoding("utf8"); res.on("data", (c) => data += c); res.on("end", () => {
        let j: any = null; try { j = JSON.parse(data); } catch { j = null; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: data, json: j });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const licensed = { verification: true };

describe("LEM-197 steered test-plan", () => {
  it("exposes plan schema covering required sections", async () => {
    expect(steeredPlanSchema.$id).toContain("steered_plan.v1.json");
    expect(steeredPlanSchema.properties.schema_version).toEqual({ const: STEERED_PLAN_SCHEMA_VERSION });
    for (const key of ["features", "checks", "personas", "test_cases", "bots", "uploads", "context"]) {
      expect(steeredPlanSchema.required).toContain(key);
      expect(steeredPlanSchema.properties[key]).toBeTruthy();
    }
    const plan = createDefaultSteeredPlan();
    expect(validateSteeredPlan(plan)).toEqual([]);
    expect(plan.schema_version).toBe(STEERED_PLAN_SCHEMA_VERSION);
  });

  it("dashboard /plan route is token-protected and license-gated; unlicensed returns ProUnavailableError", async () => {
    const root = await mk("lemma-plan-dash-");
    const store = new StateStore(root);

    // unlicensed: returns ProUnavailableError payload (403)
    const unlicensed = await startDashboard({ stateStore: store, host: "127.0.0.1", proLicense: null });
    try {
      const base = `http://127.0.0.1:${new URL(unlicensed.url).port}`;
      const noToken = await request(`${base}/plan`);
      expect(noToken.status).toBe(401);
      const res = await request(`${base}/plan?token=${unlicensed.token}`);
      expect(res.status).toBe(403);
      expect(res.json?.error?.type || res.json?.error?.code || res.json?.ok).toSatisfy((v: any) => v === "ProUnavailableError" || v === "pro_unavailable" || v === false);
      expect(res.json?.error?.message || JSON.stringify(res.json)).toMatch(/Pro|unavailable|entitlement/i);
    } finally { await unlicensed.close(); }

    // licensed: renders plan
    const licensedDash = await startDashboard({ stateStore: store, host: "127.0.0.1", proLicense: licensed });
    try {
      const base = `http://127.0.0.1:${new URL(licensedDash.url).port}`;
      const ok = await request(`${base}/plan?token=${licensedDash.token}`);
      expect(ok.status).toBe(200);
      expect(ok.headers["content-type"]).toContain("text/html");
      expect(ok.text).toContain("Steered Test Plan");
    } finally { await licensedDash.close(); }

    // direct handler also enforces license
    await expect(async () => {
      const out = await handlePlanRoute({ root, license: null, method: "GET" });
      if (out.status === 403) throw new ProUnavailableError("steered test plan (/plan)");
    }).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("validates, size-bounds, and redacts uploads; specs/docs referenced by hash and raw credentials never stored", async () => {
    const root = await mk("lemma-plan-upload-");
    const store = new SteeredPlanStore({ root });

    const secret = "Authorization: Bearer supersecret-token\napi_key=abc123\nopenapi: 3.0.0";
    const { plan, upload } = await store.addUpload({ kind: "spec", name: "api.yaml", content: secret, content_type: "text/yaml" });

    expect(upload.kind).toBe("spec");
    expect(upload.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(upload.reference).toBe(`sha256:${upload.hash}`);
    expect(upload.stored).toBe(false);
    expect(upload.redacted).toBe(true);
    expect(plan.uploads.specs[0]!.reference).toBe(upload.reference);

    // raw credentials not stored in plan
    const rawPlan = await readFile(path.join(root, ".lemma", "pro", "plan.json"), "utf8");
    expect(rawPlan).not.toContain("supersecret-token");
    expect(rawPlan).not.toContain("abc123");

    // size bounded
    expect(() => processUpload({ kind: "doc", name: "big.txt", content: "x".repeat(1024) }, [], { maxBytes: 128 })).toThrow(/max size/i);

    // validation
    expect(() => processUpload({ kind: "spec", name: "empty", content: "" }, [])).toThrow(/empty/i);
  });

  it("persists plan under .lemma/pro/plan.json via atomic writes and audits every change (JSONL)", async () => {
    const root = await mk("lemma-plan-persist-");
    const store = new SteeredPlanStore({ root });

    const saved = await store.save({ features: [{ id: "f1" }], checks: [{ id: "c1" }], context: { connection: { baseUrl: "https://example.test" } } }, { reason: "init" });
    expect(saved.features[0]).toEqual({ id: "f1" });
    const onDisk = JSON.parse(await readFile(path.join(root, ".lemma", "pro", "plan.json"), "utf8"));
    expect(onDisk.schema_version).toBe(STEERED_PLAN_SCHEMA_VERSION);
    expect(onDisk.features[0].id).toBe("f1");

    await store.update({ bots: { count: 2 } }, { reason: "bots" });
    await store.addUpload({ kind: "doc", name: "notes.txt", content: "hello world" });

    const auditRaw = await readFile(path.join(root, ".lemma", "pro", "plan.audit.jsonl"), "utf8");
    const lines = auditRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThanOrEqual(4); // save, update, save-from-upload, upload event(s)
    expect(lines.every((e) => e.schema_version === "lemma.pro.steered_plan_audit/v1")).toBe(true);
    expect(lines.some((e) => e.action === "save")).toBe(true);
    expect(lines.some((e) => e.action === "upload")).toBe(true);
    expect(lines.some((e) => e.reason === "init" || e.reason === "bots" || e.reason?.startsWith("upload"))).toBe(true);
  });
});
