import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runIntl } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-intl-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-178 intl/localization workflow", () => {
  it("builds requirements matrix, detects implementation gaps, records runtime evidence (redacted), and produces schema-valid report", async () => {
    await withTempDir(async (root) => {
      const secret = "sk-INTL-SECRET-1234567890";
      const report = await runIntl({
        root,
        target: "https://example.com",
        locales: ["en-US", "ar"],
        requirements: { rtl: true, plurals: true, dateNumberFormats: true, textExpansion: true },
        inspections: {
          "en-US": { locale: "en-US", renderedHtml: `<html><body>Hello token=${secret}</body></html>`, hardcodedStrings: ["Submit"], missingTranslations: ["checkout.title"] },
          "ar": { locale: "ar", renderedHtml: `<html dir="ltr"><body>مرحبا</body></html>` }, // RTL locale but no rtl signal => gap
        },
      } as any);

      expect(report.schema_version).toBe("lemma.intl_report/v1");
      expect(report.requirements_matrix.length).toBeGreaterThan(0);
      const reqTypes = new Set(report.requirements_matrix.map(r => r.requirement));
      expect(reqTypes.has("rtl")).toBe(true);
      expect(reqTypes.has("plurals")).toBe(true);
      expect(reqTypes.has("date_number_formats")).toBe(true);
      expect(reqTypes.has("text_expansion")).toBe(true);

      // implementation gaps detected
      expect(report.implementation_gaps.some(g => g.type === "hardcoded_string" && g.value === "Submit")).toBe(true);
      expect(report.implementation_gaps.some(g => g.type === "missing_translation" && g.value === "checkout.title")).toBe(true);

      // runtime evidence per inspected locale, redacted
      expect(report.runtime_evidence.some(e => e.locale === "en-US" && e.redacted === true)).toBe(true);
      expect(report.runtime_evidence.some(e => e.locale === "ar")).toBe(true);
      const enArtifact = report.runtime_evidence.find(e => e.locale === "en-US")?.artifact;
      expect(enArtifact).toBeTruthy();
      const runDir = path.join(root, ".lemma", "evidence", report.run_id);
      const files = await fs.readdir(runDir);
      expect(files.some(f => f.includes("intl-runtime-en-US"))).toBe(true);
      // persisted runtime artifact redacted
      const artPath = files.find(f => f.includes("intl-runtime-en-US"))!;
      const artContent = await fs.readFile(path.join(runDir, artPath), "utf8");
      expect(artContent).not.toContain(secret);

      const schemaRaw = await fs.readFile(path.join(process.cwd(), "schemas/intl/report.v1.schema.json"), "utf8").catch(() => null);
      if (schemaRaw) expect(JSON.parse(schemaRaw).properties.schema_version.const).toBe("lemma.intl_report/v1");
    });
  });

  it("marks locales unreviewed when no reviewer available (never pass) and explicitly unreviewed with reason when not inspected (no silent skip)", async () => {
    await withTempDir(async (root) => {
      const report = await runIntl({
        root,
        target: "https://example.com",
        locales: ["en-US", "fr-FR", "ja"],
        reviewAvailable: false,
        inspections: {
          "en-US": { locale: "en-US", renderedHtml: "<html><body>Hello</body></html>" },
          // fr-FR and ja not inspected
        },
      } as any);

      const fr = report.locales.find(l => l.locale === "fr-FR")!;
      const ja = report.locales.find(l => l.locale === "ja")!;
      expect(fr.status).toBe("unreviewed");
      expect(fr.reason).toMatch(/not inspected/i);
      expect(ja.status).toBe("unreviewed");
      expect(ja.reason).toMatch(/not inspected/i);

      const en = report.locales.find(l => l.locale === "en-US")!;
      expect(en.status).not.toBe("reviewed"); // no reviewer
      const ctxEn = report.contextual_review.locales.find(l => l.locale === "en-US")!;
      expect(ctxEn.status).toBe("unreviewed");
      expect(ctxEn.reason).toMatch(/no reviewer/i);
      expect(report.contextual_review.available).toBe(false);

      // no locale silently skipped - every requested locale present
      expect(report.locales.map(l => l.locale).sort()).toEqual(["en-US", "fr-FR", "ja"].sort());
      expect(report.contextual_review.locales.map(l => l.locale).sort()).toEqual(["en-US", "fr-FR", "ja"].sort());
    });
  });

  it("marks locales reviewed only when reviewer available", async () => {
    await withTempDir(async (root) => {
      const report = await runIntl({
        root,
        target: "https://example.com",
        locales: ["en-US"],
        reviewer: { id: "human-1" },
        inspections: { "en-US": { locale: "en-US", renderedHtml: "<html><body>Hello</body></html>" } },
      } as any);
      expect(report.contextual_review.available).toBe(true);
      expect(report.contextual_review.locales[0].status).toBe("reviewed");
      expect(report.locales[0].status).toBe("reviewed");
    });
  });
});
