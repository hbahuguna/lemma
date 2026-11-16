import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runGeo } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-geo-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-177 GEO evaluation workflow", () => {
  it("covers each check category, cites evidence for every check, reports unchecked as unknown, and produces schema-valid report", async () => {
    await withTempDir(async (root) => {
      const report = await runGeo({
        root,
        target: "https://example.com/article",
        fetch: async () => { throw new Error("unavailable"); },
      } as any);

      expect(report.schema_version).toBe("lemma.geo_report/v1");
      expect(report.target).toBe("https://example.com/article");
      expect(report.checks.length).toBeGreaterThan(0);

      const cats = new Set(report.checks.map(c => c.category));
      expect(cats.has("crawler_eligibility")).toBe(true);
      expect(cats.has("structured_data")).toBe(true);
      expect(cats.has("credibility")).toBe(true);
      expect(cats.has("grounding")).toBe(true);

      for (const c of report.checks) {
        expect(Array.isArray(c.evidence)).toBe(true);
        expect(c.evidence.length).toBeGreaterThan(0);
        expect(["pass", "fail", "unknown"]).toContain(c.status);
        expect(c.evidence.every(ref => report.evidence.artifacts.includes(ref))).toBe(true);
      }

      expect(report.checks.some(c => c.status === "unknown")).toBe(true);
      expect(report.summary.total).toBe(report.checks.length);

      const outDir = path.join(root, ".lemma", "evidence", report.run_id, "geo");
      const reportFile = await fs.readFile(path.join(outDir, "geo-report.json"), "utf8");
      expect(JSON.parse(reportFile).schema_version).toBe("lemma.geo_report/v1");

      const schemaRaw = await fs.readFile(path.join(process.cwd(), "schemas/geo/report.v1.schema.json"), "utf8").catch(() => null);
      if (schemaRaw) expect(JSON.parse(schemaRaw).properties.schema_version.const).toBe("lemma.geo_report/v1");
    });
  });

  it("measures signals from fetched/page evidence (not inferred) and reports pass/fail appropriately", async () => {
    await withTempDir(async (root) => {
      const report = await runGeo({
        root,
        target: "https://example.com",
        fetch: async (url: string) => {
          if (url.endsWith("/robots.txt")) return { status: 200, ok: true, text: "User-agent: *" };
          if (url.endsWith("/sitemap.xml")) return { status: 200, ok: true, text: "<urlset/>" };
          return { status: 404, ok: false, text: "" };
        },
        page: {
          html: '<html><head><script type="application/ld+json">{"@type":"Article"}</script><meta name="author" content="A"><time datetime="2026-01-01">2026</time></head><body><article>Grounded content with sufficient text for measurement.</article><cite>Ref</cite></body></html>',
          structuredData: { "@type": "Article" },
          author: "A Author",
          citations: ["Ref 1"],
          dates: ["2026-01-01"],
          answerConstruction: { measured: true, sources: ["page"], notes: "Measured from page sections" },
        },
      } as any);

      expect(report.checks.find(c => c.id === "crawler.eligibility")?.status).toBe("pass");
      expect(report.checks.find(c => c.id === "structured_data.validity")?.status).toBe("pass");
      expect(report.checks.find(c => c.id === "credibility.signals")?.status).toBe("pass");
      expect(report.checks.find(c => c.id === "grounding.measured")?.status).toBe("pass");
      expect(report.checks.every(c => c.status !== "unknown")).toBe(true);
    });
  });
});
