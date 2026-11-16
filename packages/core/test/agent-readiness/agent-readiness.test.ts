import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runAgentReadiness } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-agent-readiness-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const failFetch = async () => ({ status: 404, ok: false, text: "" });
const okFetch = (text = "ok") => async () => ({ status: 200, ok: true, text });

describe("LEM-176 agent-readiness workflow", () => {
  it("returns schema-valid report and cites evidence for every check; unchecked items reported as unknown (never pass)", async () => {
    await withTempDir(async (root) => {
      const report = await runAgentReadiness({
        root,
        target: "https://example.com",
        fetch: async () => { throw new Error("unavailable"); },
        // no page inspection data => unknowns
      } as any);

      expect(report.schema_version).toBe("lemma.agent_readiness_report/v1");
      expect(report.target).toBe("https://example.com");
      expect(report.checks.length).toBeGreaterThan(0);
      expect(report.summary.total).toBe(report.checks.length);

      for (const c of report.checks) {
        expect(Array.isArray(c.evidence)).toBe(true);
        expect(c.evidence.length).toBeGreaterThan(0);
        expect(["pass", "fail", "unknown"]).toContain(c.status);
      }

      // with no inspected page data and no fetchable resources, relevant checks must be unknown (never pass)
      const unknowns = report.checks.filter(c => c.status === "unknown");
      expect(unknowns.length).toBeGreaterThan(0);
      expect(report.checks.some(c => c.status === "unknown" && c.dimension === "semantics")).toBe(true);
      expect(report.checks.some(c => c.status === "unknown" && c.dimension === "observability")).toBe(true);

      // evidence persisted
      const outDir = path.join(root, ".lemma", "evidence", report.run_id, "agent-readiness");
      const reportFile = await fs.readFile(path.join(outDir, "agent-readiness-report.json"), "utf8");
      expect(JSON.parse(reportFile).schema_version).toBe("lemma.agent_readiness_report/v1");

      const schemaRaw = await fs.readFile(path.join(process.cwd(), "schemas/agent_readiness/report.v1.schema.json"), "utf8").catch(() => null);
      if (schemaRaw) expect(JSON.parse(schemaRaw).properties.schema_version.const).toBe("lemma.agent_readiness_report/v1");
    });
  });

  it("covers discoverability, semantics, safety, and observability dimensions with evidence linkage", async () => {
    await withTempDir(async (root) => {
      const report = await runAgentReadiness({
        root,
        target: "https://example.com/docs",
        fetch: async (url: string) => {
          if (url.endsWith("/robots.txt")) return { status: 200, ok: true, text: "User-agent: *" };
          if (url.endsWith("/sitemap.xml")) return { status: 200, ok: true, text: "<urlset/>" };
          if (url.endsWith("/openapi.json")) return { status: 200, ok: true, text: '{"openapi":"3.0.0"}' };
          return { status: 404, ok: false, text: "" };
        },
        page: {
          html: '<html><body><label for="n">Name</label><input id="n" data-testid="name"><script type="application/ld+json">{}</script></body></html>',
          labels: ["Name"],
          ids: ["n"],
          forms: [{ action: "/delete", method: "POST", gated: true, hasConfirmation: true }],
          errors: [{ code: "E1", message: "bad" }],
          logs: [{ level: "info", msg: "ok" }],
          traceIds: ["trace-1"],
          structuredData: { "@type": "Thing" },
          openapi: { openapi: "3.0.0" },
        },
      } as any);

      const dims = new Set(report.checks.map(c => c.dimension));
      expect(dims.has("discoverability")).toBe(true);
      expect(dims.has("semantics")).toBe(true);
      expect(dims.has("safety")).toBe(true);
      expect(dims.has("observability")).toBe(true);

      expect(report.checks.find(c => c.id === "discoverability.resources")?.status).toBe("pass");
      expect(report.checks.find(c => c.id === "semantics.labels")?.status).toBe("pass");
      expect(report.checks.find(c => c.id === "safety.destructive_gated")?.status).toBe("pass");
      expect(report.checks.find(c => c.id === "observability.trace_ids")?.status).toBe("pass");

      for (const c of report.checks) {
        expect(c.evidence.length).toBeGreaterThan(0);
        // evidence refs should be recorded in artifacts
        expect(c.evidence.every(ref => report.evidence.artifacts.includes(ref))).toBe(true);
      }
    });
  });

  it("reports fail/unknown appropriately without ever marking unchecked as pass", async () => {
    await withTempDir(async (root) => {
      const report = await runAgentReadiness({
        root,
        target: "https://example.com",
        fetch: failFetch,
        page: {
          html: '<html><body><form action="/delete" method="POST"></form></body></html>',
          forms: [{ action: "/delete", method: "POST" }], // destructive ungated
          traceIds: [],
        },
      } as any);

      expect(report.checks.find(c => c.id === "safety.destructive_gated")?.status).toBe("fail");
      expect(report.checks.find(c => c.id === "observability.trace_ids")?.status).toBe("fail");
      // some items remain unknown (e.g. logs/errors not inspected)
      expect(report.checks.some(c => c.status === "unknown")).toBe(true);
      expect(report.checks.every(c => !(c.status === "pass" && c.evidence.length === 0))).toBe(true);
    });
  });
});
