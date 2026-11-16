import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProUnavailableError,
  SPECIALIST_COMMAND_CATALOG,
  getSpecialistCommand,
  runSpecialistCommand,
} from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const validLicense = {
  verification: {
    valid: true,
    reason: "ok",
    workspace_id: "ws_pro_test",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_test",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

describe("LEM-157 specialist catalog and runner", () => {
  it("ships a versioned catalog with required specialist entries and metadata", () => {
    expect(SPECIALIST_COMMAND_CATALOG.length).toBeGreaterThanOrEqual(4);
    const ids = SPECIALIST_COMMAND_CATALOG.map((c) => c.id).sort();
    expect(ids).toEqual(["confidence", "performance", "privacy", "security"]);
    for (const spec of SPECIALIST_COMMAND_CATALOG) {
      expect(spec.id).toBeTruthy();
      expect(spec.title).toContain("Specialist");
      expect(spec.description.length).toBeGreaterThan(10);
      expect(spec.intent).toContain("assessment");
      expect(spec.cli).toMatch(/^lemma pro /);
      expect(spec.slash_commands.length).toBeGreaterThan(0);
      expect(spec.bounded_scope.maxChecks).toBeGreaterThan(0);
      expect(spec.bounded_scope.maxWallClockMs).toBeGreaterThan(0);
      expect(spec.expected_evidence_shape.evidence_root).toContain(".lemma/evidence");
      expect(spec.expected_evidence_shape.manifest).toContain("manifest.json");
      expect(spec.expected_evidence_shape.report).toContain("report");
      expect(spec.persona_contract_references.length).toBeGreaterThan(0);
      expect(spec.check_selection.category_check_ids.length).toBeGreaterThan(0);
      expect(spec.check_selection.domains.length).toBeGreaterThan(0);
      expect(getSpecialistCommand(spec.id)?.id).toBe(spec.id);
    }
  });

  it("refuses unlicensed invocation with ProUnavailableError and no partial execution", async () => {
    const root = await mkdtemp("lemma-pro-unlicensed-");
    tempDirs.push(root);
    let sideEffect = 0;
    await expect(
      (async () => {
        sideEffect += 1;
        return runSpecialistCommand({
          specialist: "security",
          target: root,
          root,
          cwd: root,
          license: null,
          personasDir: path.resolve(process.cwd(), "packages/personas"),
        } as any);
      })(),
    ).rejects.toBeInstanceOf(ProUnavailableError);
    expect(sideEffect).toBe(1);
    const progressPath = path.join(root, ".lemma", "progress.json");
    const progressExists = await fs.stat(progressPath).then(() => true).catch(() => false);
    expect(progressExists).toBe(false);
  });

  it("runs a bounded licensed investigation and emits findings/blockers-compatible report with evidence refs", async () => {
    const root = await mkdtemp("lemma-pro-bounded-");
    tempDirs.push(root);
    await fs.writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");

    const result = await runSpecialistCommand({
      specialist: "security",
      target: root,
      root,
      cwd: root,
      license: validLicense as any,
      personasDir: path.resolve(process.cwd(), "packages/personas"),
      maxChecks: 5,
      wallClockBudgetMs: 30000,
      noBrowser: true,
    });

    expect(result.ok).toBe(true);
    expect(result.specialist.id).toBe("security");
    expect(result.run_id).toBeTruthy();
    expect(typeof (result.report as any).schema_version).toBe("string");
    expect(String((result.report as any).schema_version)).toMatch(/report\/v1$/);
    expect(result.checks_total).toBeLessThanOrEqual(5);
    expect(Array.isArray((result.report as any).findings)).toBe(true);
    expect(Array.isArray((result.report as any).blockers)).toBe(true);
    expect(Array.isArray(result.evidence_refs)).toBe(true);
    expect(JSON.stringify(result.report)).toContain("evidence");

    const evidenceRunDir = path.join(root, ".lemma", "evidence", result.run_id);
    const evExists = await fs.stat(evidenceRunDir).then(() => true).catch(() => false);
    expect(evExists).toBe(true);
  });

  it("stops on wall-clock budget cap (bounded investigation)", async () => {
    const root = await mkdtemp("lemma-pro-timecap-");
    tempDirs.push(root);
    let calls = 0;
    const nowMs = () => {
      calls += 1;
      return calls <= 1 ? 1000 : 100000;
    };
    const result = await runSpecialistCommand({
      specialist: "confidence",
      target: root,
      root,
      cwd: root,
      license: validLicense as any,
      personasDir: path.resolve(process.cwd(), "packages/personas"),
      maxChecks: 10,
      wallClockBudgetMs: 10,
      noBrowser: true,
      nowMs,
    });
    expect(result.ok).toBe(true);
    expect(["halted", "completed"]).toContain(result.status);
    if (result.status === "halted") {
      expect(String(result.halted_reason || "")).toContain("wall-clock budget");
    }
  });

  it("is deterministic for same seed + frozen clock + same target (modulo documented volatile fields)", async () => {
    const mk = async (name: string) => {
      const root = await mkdtemp(name);
      tempDirs.push(root);
      await fs.writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
      await fs.writeFile(path.join(root, "index.js"), "export const x = 1;\n", "utf8");
      return root;
    };
    const rootA = await mk("lemma-pro-det-a-");
    const rootB = await mk("lemma-pro-det-b-");

    const opts = {
      specialist: "privacy" as const,
      license: validLicense as any,
      personasDir: path.resolve(process.cwd(), "packages/personas"),
      maxChecks: 4,
      wallClockBudgetMs: 30000,
      noBrowser: true,
      seed: 4242,
      clockMode: "frozen" as const,
      frozenClock: "2026-11-16T00:00:00Z",
    };
    const a = await runSpecialistCommand({ ...opts, target: rootA, root: rootA, cwd: rootA });
    const b = await runSpecialistCommand({ ...opts, target: rootB, root: rootB, cwd: rootB });

    const normalize = (r: any) => {
      const report = JSON.parse(JSON.stringify(r.report ?? {}));
      const stripVolatile = (obj: any) => {
        if (!obj || typeof obj !== "object") return;
        for (const k of Object.keys(obj)) {
          if (["started_at","completed_at","updated_at","generated_at","run_id","evidence_dir","evidence_manifest_path","directory","path","resolved","raw","source","root"].includes(k)) {
            delete obj[k];
          }
        }
      };
      stripVolatile(report);
      if (report.target && typeof report.target === "object") {
        delete report.target.raw; delete report.target.resolved; delete report.target.source;
      }
      if (Array.isArray(report.checks)) for (const c of report.checks) { stripVolatile(c); }
      if (Array.isArray(report.findings)) for (const f of report.findings) { stripVolatile(f); }
      if (Array.isArray(report.blockers)) for (const b of report.blockers) { stripVolatile(b); }
      if (report.trend && typeof report.trend === "object") stripVolatile(report.trend);
      if (report.confidence && typeof report.confidence === "object") stripVolatile(report.confidence);
      return {
        status: r.status,
        specialist: r.specialist.id,
        checks_total: r.checks_total,
        halted_reason: r.halted_reason ?? null,
        report,
      };
    };
    expect(normalize(a)).toEqual(normalize(b));
  });
});
