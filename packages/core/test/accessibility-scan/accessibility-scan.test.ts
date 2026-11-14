import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  EvidenceStore,
  Severity,
  SourceInspector,
  StaticCheckRunner,
  Strength,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-a11y-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function touch(file: string, content = "") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

async function readEvidenceJson(root: string, relPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, relPath), "utf8")) as Record<string, unknown>;
}

describe("LEM-030 accessibility markup scan", () => {
  it("passes with assay-compatible outcome and evidence when no barriers match", async () => {
    await withTempDir(async (root) => {
      await touch(
        path.join(root, "index.html"),
        '<!doctype html><html lang="en"><head><title>x</title></head><body><img alt="ok" src="a.png"><label for="n">Name</label><input id="n"></body></html>\n',
      );

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-a11y-clean");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.accessibility" });

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.findings).toEqual([]);
      expect(outcome.actual).toBe("No obvious source-level accessibility barriers matched.");
      expect(outcome.metadata).toEqual({ matches: 0 });
      expect(outcome.evidence[0]).toMatch(/source-accessibility-scan\.json$/);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload.matches).toEqual([]);
      expect(payload.files_scanned).toEqual(inventory.markup_files);

      const entries = evidence.getEntries();
      expect(entries[0]?.kind).toBe("static_analysis");
      expect(entries[0]?.description).toBe(
        "Static accessibility heuristics on markup and component templates.",
      );
      expect(entries[0]?.check_id).toBe("static.accessibility");
    });
  });

  it("reports grouped rule matches with assay-compatible findings and evidence payload", async () => {
    await withTempDir(async (root) => {
      await touch(
        path.join(root, "src", "Page.html"),
        [
          "<html>",
          '  <body>',
          '    <img src="a.png">',
          '    <img src="b.png">',
          '    <input type="text">',
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      );

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-a11y-match");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.accessibility" });

      expect(outcome.status).toBe(CheckStatus.FAILED);
      expect(outcome.actual).toBe(
        `${(outcome.metadata as { matches: number }).matches} source-level accessibility match(es) across ${inventory.markup_files.length} markup file(s).`,
      );
      expect((outcome.metadata as { matches: number }).matches).toBeGreaterThan(0);
      expect(outcome.findings.length).toBeGreaterThan(0);

      const imgFinding = outcome.findings.find((f) => f.title.includes("Image is missing an alt attribute"));
      expect(imgFinding).toBeDefined();
      expect(imgFinding!.domain).toBe("accessibility");
      expect(imgFinding!.strength).toBe(Strength.SOURCE_PROVEN);
      expect(imgFinding!.location).toBe("src/Page.html:3");
      expect(imgFinding!.reproduction).toBe(
        "Inspect the cited markup and verify the rendered accessibility tree.",
      );
      expect(imgFinding!.remediation).toBe(
        'Add meaningful alt text, or alt="" for decorative images.',
      );
      expect(imgFinding!.tags).toEqual(["accessibility", "img-alt"]);
      expect(imgFinding!.title).toContain("(2 occurrences in src/Page.html)");

      const htmlLang = outcome.findings.find((f) => f.title.includes("Document language is not declared"));
      expect(htmlLang).toBeDefined();
      expect(htmlLang!.tags).toEqual(["accessibility", "html-lang"]);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      const matches = payload.matches as Array<Record<string, unknown>>;
      expect(Array.isArray(matches)).toBe(true);
      expect(matches.length).toBe((outcome.metadata as { matches: number }).matches);
      expect(payload.files_scanned).toEqual(inventory.markup_files);
      expect(matches.some((m) => m.rule === "img-alt" && m.file === "src/Page.html")).toBe(true);
    });
  });

  it("downgrades severities for matches in test paths", async () => {
    await withTempDir(async (root) => {
      await touch(
        path.join(root, "tests", "Component.tsx"),
        'export const C = () => <div><img src="a.png" /></div>;\n',
      );

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-a11y-testpath");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.accessibility" });

      expect(outcome.status).toBe(CheckStatus.FAILED);
      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      const matches = payload.matches as Array<{ rule: string; severity: string; file: string }>;
      const img = matches.find((m) => m.rule === "img-alt");
      expect(img).toBeDefined();
      // img-alt is MEDIUM, downgraded once in test paths -> LOW
      expect(img!.severity).toBe(Severity.LOW);
      expect(img!.file).toBe("tests/Component.tsx");
      const finding = outcome.findings.find((f) => f.tags.includes("img-alt"));
      expect(finding?.severity).toBe(Severity.LOW);
    });
  });
});
