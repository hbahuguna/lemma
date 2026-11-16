import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HarnessError, SsrfError, runLoad } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-load-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function okRequest(d = 5) {
  return async () => ({ status: 200, ok: true, duration_ms: d });
}

describe("LEM-173 load-readiness workflow", () => {
  it("requires explicit approval and does not send any traffic when not approved", async () => {
    await withTempDir(async (root) => {
      let calls = 0;
      await expect(runLoad({
        root,
        target: "https://example.com",
        limits: { max_concurrent_connections: 1, max_total_requests: 1, max_wall_clock_ms: 1000 },
        approve: () => false,
        request: async () => { calls += 1; return { status: 200, ok: true, duration_ms: 1 }; },
      } as any)).rejects.toBeInstanceOf(HarnessError);
      expect(calls).toBe(0);
    });
  });

  it("rejects non-safe targets before any traffic (SSRF rules)", async () => {
    await withTempDir(async (root) => {
      let calls = 0;
      await expect(runLoad({
        root,
        target: "http://127.0.0.1:8080",
        limits: { max_concurrent_connections: 1, max_total_requests: 1, max_wall_clock_ms: 1000 },
        approve: () => true,
        request: async () => { calls += 1; return { status: 200, ok: true, duration_ms: 1 }; },
      } as any)).rejects.toBeInstanceOf(SsrfError);
      expect(calls).toBe(0);
    });
  });

  it("enforces hard limits and halts cleanly (max_total_requests)", async () => {
    await withTempDir(async (root) => {
      let calls = 0;
      const report = await runLoad({
        root,
        target: "https://example.com",
        journeys: [{ steps: [{ path: "/a" }, { path: "/b" }, { path: "/c" }] }],
        limits: { max_concurrent_connections: 2, max_total_requests: 2, max_wall_clock_ms: 5000 },
        approve: () => true,
        request: async () => { calls += 1; return { status: 200, ok: true, duration_ms: 1 }; },
      } as any);
      expect(calls).toBe(2);
      expect(report.status).toBe("halted");
      expect(report.summary.halted_reason).toMatch(/max_total_requests/);
      expect(report.summary.requests_attempted).toBe(2);
    });
  });

  it("enforces wall-clock halt cleanly", async () => {
    await withTempDir(async (root) => {
      let t = 0;
      const report = await runLoad({
        root,
        target: "https://example.com",
        traffic: [{ path: "/1" }, { path: "/2" }, { path: "/3" }],
        limits: { max_concurrent_connections: 1, max_total_requests: 10, max_wall_clock_ms: 5 },
        approve: () => true,
        nowMs: () => t,
        sleep: async () => { /* no-op */ },
        request: async () => { t += 10; return { status: 200, ok: true, duration_ms: 10 }; },
      } as any);
      expect(report.status).toBe("halted");
      expect(report.summary.halted_reason).toMatch(/max_wall_clock/);
    });
  });

  it("writes evidence under .lemma/evidence/<run_id>/load with transcripts and timing histograms, and returns schema-valid report", async () => {
    await withTempDir(async (root) => {
      const runId = "load-test-run";
      const report = await runLoad({
        root,
        runId,
        target: "https://example.com",
        traffic: [{ path: "/a" }, { path: "/b" }],
        limits: { max_concurrent_connections: 2, max_total_requests: 5, max_wall_clock_ms: 5000 },
        approve: () => ({ approved: true }),
        request: okRequest(7),
      } as any);

      expect(report.schema_version).toBe("lemma.load_report/v1");
      expect(report.run_id).toBe(runId);
      expect(report.status).toBe("completed");
      expect(report.approved).toBe(true);
      expect(report.safe_target_validated).toBe(true);
      expect(report.evidence.directory).toBe(`.lemma/evidence/${runId}/load`);
      expect(report.evidence.artifacts.length).toBeGreaterThan(0);

      const loadDir = path.join(root, ".lemma", "evidence", runId, "load");
      const transcripts = await fs.readFile(path.join(loadDir, "transcripts.json"), "utf8");
      const hist = await fs.readFile(path.join(loadDir, "timing-histogram.json"), "utf8");
      const reportFile = await fs.readFile(path.join(loadDir, "load-report.json"), "utf8");
      expect(JSON.parse(transcripts)).toBeInstanceOf(Array);
      expect(JSON.parse(hist)).toHaveProperty("counts");
      expect(JSON.parse(reportFile).schema_version).toBe("lemma.load_report/v1");

      // schema file exists (AC reference)
      const schemaRaw = await fs.readFile(path.join(process.cwd(), "schemas/load/load_report.v1.schema.json"), "utf8").catch(() => null);
      if (schemaRaw) {
        const schema = JSON.parse(schemaRaw);
        expect(schema.properties.schema_version.const).toBe("lemma.load_report/v1");
        expect(schema.required).toContain("evidence");
      }
    });
  });

  it("applies redaction to persisted evidence and report payloads", async () => {
    await withTempDir(async (root) => {
      const secret = "sk-SECRET-TOKEN-123456789012345";
      const runId = "load-redact";
      const report = await runLoad({
        root,
        runId,
        target: "https://example.com",
        traffic: [{ path: "/a", headers: { authorization: `Bearer ${secret}` }, body: { token: secret } }],
        limits: { max_concurrent_connections: 1, max_total_requests: 1, max_wall_clock_ms: 5000 },
        approve: () => true,
        request: async () => ({ status: 200, ok: true, duration_ms: 1, error: undefined }),
      } as any);

      const loadDir = path.join(root, ".lemma", "evidence", runId, "load");
      const transcripts = await fs.readFile(path.join(loadDir, "transcripts.json"), "utf8");
      const reportFile = await fs.readFile(path.join(loadDir, "load-report.json"), "utf8");
      expect(transcripts).not.toContain(secret);
      expect(reportFile).not.toContain(secret);
      expect(JSON.stringify(report)).not.toContain(secret);
    });
  });
});
