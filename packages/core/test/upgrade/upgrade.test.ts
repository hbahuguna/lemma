import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HarnessError, StateError, runUpgrade } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-upgrade-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function scenario(title = "S") {
  return {
    title,
    steps: [
      { step_number: 1, name: "Go", action: "goto", target: "https://example.test", value: "", options: {}, raw_instruction: "Go" },
      { step_number: 2, name: "See", action: "assert_visible", target: "body", value: "", options: {}, raw_instruction: "See" },
    ],
    source: "explicit",
    model: "",
    target_url: "https://example.test",
  };
}

const sources: Array<{ kind: any; content: any }> = [
  { kind: "selenium", content: "def test_login():\n  pass\ndef test_checkout():\n  pass\n" },
  { kind: "playwright", content: "test('user can login', async () => {});\ntest('user can buy', async () => {});" },
  { kind: "cypress", content: "it('shows home', () => {});\nit('submits form', () => {});" },
  { kind: "pytest", content: "def test_alpha():\n  assert True\ndef test_beta():\n  assert True\n" },
  { kind: "junit", content: "public class T { @Test public void testOne(){} @Test public void testTwo(){} }" },
  { kind: "testrail", content: { cases: [{ id: "C1", title: "Case 1", scenario: scenario("Case 1") }] } },
  { kind: "xray", content: { tests: [{ key: "X-1", name: "Xray 1", scenario: scenario("Xray 1") }] } },
  { kind: "xlsx", content: { format: "xlsx", rows: [{ id: "R1", title: "Row 1", scenario: scenario("Row 1") }] } },
  { kind: "docx", content: { format: "docx", sections: [{ id: "D1", title: "Doc 1", scenario: scenario("Doc 1") }] } },
  { kind: "manual", content: "1. User logs in\n\n2. User logs out" },
];

describe("LEM-172 upgrade workflow", () => {
  it("produces dry-run report first and does not write upgraded tests on dry-run", async () => {
    await withTempDir(async (root) => {
      const res = await runUpgrade({ root, source: { kind: "playwright", content: "test('a',()=>{})" }, dryRun: true });
      expect(res.status).toBe("dry-run");
      expect(res.mode).toBe("dry-run");
      expect(res.counts.planned).toBeGreaterThan(0);
      await expect(fs.access(path.join(root, ".lemma", "tests", "upgraded"))).rejects.toBeTruthy();
    });
  });

  it("apply requires approval callback (mutation gate) and refusal leaves source untouched / writes nothing", async () => {
    await withTempDir(async (root) => {
      const srcPath = path.join(root, "src.spec.ts");
      const original = "test('keep me',()=>{})";
      await fs.writeFile(srcPath, original, "utf8");

      await expect(runUpgrade({ root, source: { kind: "playwright", path: "src.spec.ts" }, dryRun: false } as any)).rejects.toBeInstanceOf(HarnessError);

      const declined = await runUpgrade({ root, source: { kind: "playwright", path: "src.spec.ts" }, dryRun: false, approve: () => ({ approved: false, reason: "no" }) });
      expect(declined.status).toBe("declined");
      expect(declined.approval?.approved).toBe(false);
      expect(await fs.readFile(srcPath, "utf8")).toBe(original);
      await expect(fs.access(path.join(root, ".lemma", "tests", "upgraded"))).rejects.toBeTruthy();
    });
  });

  it("apply writes validated lemma-native tests under .lemma/tests/upgraded tagged with origin; source preserved; reversible (never overwrite source)", async () => {
    await withTempDir(async (root) => {
      const srcPath = path.join(root, "tests.py");
      const original = "def test_one():\n  pass\n";
      await fs.writeFile(srcPath, original, "utf8");
      const res = await runUpgrade({ root, source: { kind: "pytest", path: "tests.py", id: "py-suite" }, target: "pytest-suite", dryRun: false, approve: () => true });
      expect(res.status).toBe("applied");
      expect(res.applied?.suite).toBe("pytest-suite");
      expect(await fs.readFile(srcPath, "utf8")).toBe(original);

      const manifestPath = path.join(root, ".lemma", "tests", "upgraded", "pytest-suite", "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      expect(manifest.upgraded).toBe(true);
      expect(manifest.source.kind).toBe("pytest");
      expect(manifest.intents.length).toBeGreaterThan(0);
      for (const it of manifest.intents) {
        expect(it.origin.kind).toBe("pytest");
        expect(it.origin.source_id).toBe("py-suite");
        expect(it.origin.trace).toContain("pytest:");
        expect(it.reviewed).toBe(false);
        expect(it.scenario?.steps?.length).toBeGreaterThan(0);
        expect(it.scenario.source).toBe("explicit");
        expect(typeof it.scenario.target_url).toBe("string");
      }
    });
  });

  it("re-runs are traceable (stable origin/id for same source)", async () => {
    await withTempDir(async (root) => {
      const source = { kind: "cypress" as const, content: "it('alpha',()=>{});\nit('beta',()=>{});", id: "cy" };
      const a = await runUpgrade({ root, source, target: "t1", dryRun: false, approve: () => true });
      const b = await runUpgrade({ root, source, target: "t2", dryRun: false, approve: () => true });
      expect(a.planned.map(p => p.origin_trace)).toEqual(b.planned.map(p => p.origin_trace));
      expect(a.planned.map(p => p.id)).toEqual(b.planned.map(p => p.id));
    });
  });

  for (const s of sources) {
    it(`supports source kind=${s.kind} with schema validation and origin tagging`, async () => {
      await withTempDir(async (root) => {
        const dry = await runUpgrade({ root, source: { kind: s.kind, content: s.content, id: `src-${s.kind}` }, dryRun: true });
        expect(dry.status).toBe("dry-run");
        expect(dry.source.kind).toBe(s.kind);
        expect(dry.counts.planned).toBeGreaterThan(0);
        for (const p of dry.planned) expect(p.origin_trace.startsWith(`${s.kind}:`)).toBe(true);
      });
    });
  }

  it("rejects unsupported kind", async () => {
    await withTempDir(async (root) => {
      await expect(runUpgrade({ root, source: { kind: "unknown" as any, content: "x" }, dryRun: true })).rejects.toBeInstanceOf(StateError);
    });
  });
});
