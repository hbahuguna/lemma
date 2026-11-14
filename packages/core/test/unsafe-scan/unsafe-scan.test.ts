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
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-unsafe-"));
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

describe("LEM-032 unsafe-code rules", () => {
  it("passes with assay-compatible outcome and evidence when no high-risk patterns match", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "safe.ts"), 'export const ok = (x: number) => x + 1;\n');

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-unsafe-clean");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.unsafe" });

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.findings).toEqual([]);
      expect(outcome.actual).toBe("No high-risk source patterns matched.");
      expect(outcome.metadata).toEqual({ matches: 0 });
      expect(outcome.evidence[0]).toMatch(/unsafe-pattern-scan\.json$/);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload.matches).toEqual([]);

      const entries = evidence.getEntries();
      expect(entries[0]?.kind).toBe("static_analysis");
      expect(entries[0]?.description).toBe("High-risk source pattern matches.");
      expect(entries[0]?.check_id).toBe("static.unsafe");
    });
  });

  it("reports representative unsafe matches with grouped findings and assay-compatible fields", async () => {
    await withTempDir(async (root) => {
      await touch(
        path.join(root, "src", "dynamic.py"),
        [
          "def run(code, ns):",
          "    exec(code, ns)",
          "    exec(code, ns)",
          "",
        ].join("\n"),
      );
      await touch(
        path.join(root, "src", "dashboard.js"),
        "function render(el, title) { el.innerHTML = title }\n",
      );

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-unsafe-hit");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.unsafe" });

      expect(outcome.status).toBe(CheckStatus.FAILED);
      expect(outcome.actual).toBe(
        `${(outcome.metadata as { matches: number }).matches} high-risk source pattern match(es) found.`,
      );
      const matches = (await readEvidenceJson(root, outcome.evidence[0]!)).matches as Array<Record<string, unknown>>;
      expect(matches.length).toBe((outcome.metadata as { matches: number }).matches);
      expect(matches.length).toBeGreaterThanOrEqual(3);

      const execFinding = outcome.findings.find((f) => f.tags.includes("eval"));
      expect(execFinding).toBeDefined();
      expect(execFinding!.domain).toBe("security");
      expect(execFinding!.strength).toBe(Strength.SOURCE_PROVEN);
      expect(execFinding!.location).toBe("src/dynamic.py:2");
      expect(execFinding!.title).toContain("Dynamic code execution primitive");
      expect(execFinding!.title).toContain("(2 occurrences in src/dynamic.py)");
      expect(execFinding!.reproduction).toBe(
        "Inspect the cited line and trace whether untrusted input can reach it.",
      );
      expect(execFinding!.tags).toEqual(["unsafe-pattern", "eval"]);
      expect(execFinding!.evidence).toEqual(outcome.evidence);

      const inner = outcome.findings.find((f) => f.tags.includes("inner-html"));
      expect(inner).toBeDefined();
      expect(inner!.location).toBe("src/dashboard.js:1");
      expect(inner!.severity).toBe(Severity.MEDIUM);
    });
  });

  it("applies precision rules: ignores member .exec() but flags bare exec and child_process.exec", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "db.js"), 'const row = db.exec("SELECT 1");\n');
      await touch(path.join(root, "src", "regex.ts"), "const match = pattern.exec(value);\n");
      await touch(
        path.join(root, "src", "dynamic.py"),
        "def run(code, ns):\n    exec(code, ns)\n",
      );
      await touch(
        path.join(root, "src", "child.js"),
        'const child_process = require("child_process")\nchild_process.exec(command)\n',
      );

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-unsafe-precision");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.unsafe" });

      expect(outcome.status).toBe(CheckStatus.FAILED);
      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      const matches = payload.matches as Array<{ rule: string; file: string }>;
      const files = matches.map((m) => `${m.rule}:${m.file}`);

      expect(files).toContain("eval:src/dynamic.py");
      expect(files).toContain("node-child-process-exec:src/child.js");
      expect(files.some((f) => f.endsWith("src/db.js"))).toBe(false);
      expect(files.some((f) => f.endsWith("src/regex.ts"))).toBe(false);

      const locations = outcome.findings.map((f) => f.location);
      expect(locations.some((l) => l.startsWith("src/dynamic.py:"))).toBe(true);
      expect(locations.some((l) => l.startsWith("src/child.js:"))).toBe(true);
      expect(locations.some((l) => l.startsWith("src/db.js:"))).toBe(false);
      expect(locations.some((l) => l.startsWith("src/regex.ts:"))).toBe(false);
    });
  });

  it("downgrades severities for matches in test paths", async () => {
    await withTempDir(async (root) => {
      await touch(
        path.join(root, "tests", "danger.test.js"),
        "function render(el, title) { el.innerHTML = title }\n",
      );

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-unsafe-testpath");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.unsafe" });

      expect(outcome.status).toBe(CheckStatus.FAILED);
      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      const matches = payload.matches as Array<{ rule: string; severity: string; file: string }>;
      const inner = matches.find((m) => m.rule === "inner-html");
      expect(inner).toBeDefined();
      // inner-html is MEDIUM, downgraded once in test paths -> LOW
      expect(inner!.severity).toBe(Severity.LOW);
      expect(inner!.file).toBe("tests/danger.test.js");
      const finding = outcome.findings.find((f) => f.tags.includes("inner-html"));
      expect(finding?.severity).toBe(Severity.LOW);
    });
  });
});
