import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  EvidenceStore,
  RELEASE_CONFIDENCE,
  RunStatus,
  SourceInspector,
  StaticCheckRunner,
  buildReport,
  normalizeConfidence,
  normalizeFinding,
  normalizeTarget,
  sha256File,
  type Check,
  type Finding,
  type Phase,
  type RunStateDomain,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-linktot-"));
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

function phases(): Phase[] {
  return RELEASE_CONFIDENCE.phases.map((p) => ({
    name: p.name,
    title: p.title ?? p.name,
    status: "completed",
    summary: "",
    details: {},
    started_at: null,
    completed_at: null,
  }));
}

function baseCheck(def: {
  id: string;
  title: string;
  domain: string;
  persona: string;
  kind?: string;
}): Check {
  return {
    id: def.id,
    title: def.title,
    domain: def.domain,
    persona: def.persona,
    kind: def.kind ?? "static",
    intent: "i",
    expected: "e",
    base_weight: 1,
    weight: 1,
    status: CheckStatus.PLANNED,
    actual: "",
    evidence: [],
    finding_ids: [],
    skip_reason: "",
    metadata: {},
    started_at: null,
    completed_at: null,
  };
}

describe("LEM-040 static finding-to-evidence linkage and report totals", () => {
  it("links static findings to hashed evidence artifacts and produces consistent report totals", async () => {
    await withTempDir(async (root) => {
      // Fixture designed to trigger static findings with evidence artifacts.
      await touch(path.join(root, "src", "app.js"), "eval(userInput);\n");
      await touch(
        path.join(root, "src", "config.py"),
        'api_key = "9f8a7b6c5d4e3f2a1b0c"\n',
      );
      await touch(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
      await touch(path.join(root, ".env"), "SECRET=local\n");

      const inventory = new SourceInspector(root).discover();
      const evidenceStore = new EvidenceStore(root, "run-linktot");
      await evidenceStore.init();
      const runner = new StaticCheckRunner(root, inventory, evidenceStore);

      const checkDefs = [
        { id: "static.secrets", title: "Secrets", domain: "security", persona: "security" },
        { id: "static.unsafe", title: "Unsafe", domain: "security", persona: "security" },
        { id: "static.dependencies", title: "Dependencies", domain: "data_integrity", persona: "functional" },
      ];

      const checks: Check[] = [];
      const findings: Finding[] = [];
      let findingSeq = 1;

      for (const def of checkDefs) {
        const check = baseCheck(def);
        const outcome = await runner.run({ id: def.id });
        check.status = outcome.status;
        check.actual = outcome.actual;
        check.evidence = [...outcome.evidence];
        check.metadata = { ...(outcome.metadata ?? {}) };

        for (const draft of outcome.findings) {
          const fid = `f-${String(findingSeq++).padStart(3, "0")}`;
          const finding = normalizeFinding({
            id: fid,
            title: draft.title,
            severity: draft.severity,
            domain: draft.domain,
            persona: def.persona,
            strength: draft.strength,
            consequence: draft.consequence,
            location: draft.location,
            reproduction: draft.reproduction,
            evidence: [...(draft.evidence ?? [])],
            remediation: draft.remediation,
            verification: draft.verification,
            check_id: def.id,
            tags: [...(draft.tags ?? [])],
          });
          findings.push(finding);
          check.finding_ids.push(fid);
        }
        checks.push(check);
      }

      // Sanity: scenario actually produced findings and evidence.
      expect(findings.length).toBeGreaterThan(0);
      expect(checks.every((c) => c.evidence.length > 0)).toBe(true);

      const manifest = await evidenceStore.finalize({ run_id: "run-linktot", status: RunStatus.COMPLETED });
      const verification = await evidenceStore.verify();
      expect(verification.tampered).toBe(false);
      expect(verification.missing).toEqual([]);
      expect(verification.mismatches).toEqual([]);
      expect(verification.signature_valid).toBe(true);

      // Linkage: every finding points to evidence that exists on owning check and in manifest, with matching hashes.
      const manifestByPath = new Map(manifest.evidence.map((e) => [e.path, e]));
      for (const finding of findings) {
        expect(finding.check_id).toBeTruthy();
        expect(finding.evidence.length).toBeGreaterThan(0);
        const check = checks.find((c) => c.id === finding.check_id)!;
        expect(check).toBeDefined();
        expect(check.finding_ids).toContain(finding.id);
        for (const relPath of finding.evidence) {
          expect(check.evidence).toContain(relPath);
          const entry = manifestByPath.get(relPath);
          expect(entry, `manifest entry for ${relPath}`).toBeDefined();
          expect(entry!.check_id).toBe(finding.check_id);
          expect(await sha256File(path.join(root, relPath))).toBe(entry!.sha256);
        }
      }
      // And every check's evidence is present in manifest.
      for (const check of checks) {
        for (const relPath of check.evidence) {
          expect(manifestByPath.has(relPath), `check evidence ${relPath} in manifest`).toBe(true);
        }
      }

      const confidence = normalizeConfidence({
        score: 55,
        band: "medium",
        coverage: 66.7,
        rationale: "r",
        limitations: [],
        penalties: {},
        domain_scores: {},
        breakdown: {},
        gate: { status: "warn", reasons: [], policy: "advisory-v1" },
      });
      const state: RunStateDomain = {
        schema_version: "1.0",
        run_id: "run-linktot",
        workflow_id: RELEASE_CONFIDENCE.id,
        workflow_version: RELEASE_CONFIDENCE.version,
        target: normalizeTarget({ raw: root, kind: "directory", resolved: root, source: "" }),
        intent: "verify static linkage and totals",
        status: RunStatus.COMPLETED,
        current_phase: "confidence_scoring",
        phases: phases(),
        risks: [],
        checks,
        findings,
        invalid_findings: [],
        blockers: [],
        contract_failures: {},
        contract_failure_streaks: {},
        degraded_personas: [],
        confidence,
        kill_switch: { armed: true, threshold: "critical", triggered: false, reason: "", triggered_at: null, finding_id: "", manual: false },
        inventory,
        personas: [],
        options: {},
        evidence_dir: manifest.summary.directory,
        started_at: "2026-11-14T00:00:00Z",
        updated_at: "2026-11-14T00:01:00Z",
        completed_at: "2026-11-14T00:01:00Z",
        halted_reason: "",
        error: "",
        seed: null,
        clock_mode: "real",
      };

      const report = buildReport(state, RELEASE_CONFIDENCE, manifest.summary as unknown as Record<string, unknown>, "2026-11-14T00:01:00Z");

      // Finding totals/counts
      const severityCounts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      for (const f of findings) severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1;
      expect(report.finding_counts).toEqual(severityCounts);
      expect((report.findings as unknown[]).length).toBe(findings.length);

      // Coverage totals consistent with checks
      const cov = report.coverage as Record<string, unknown>;
      expect(cov.total_checks).toBe(checks.length);
      expect(cov.executed).toBe(checks.length); // all passed/failed
      expect(cov.passed).toBe(checks.filter((c) => c.status === CheckStatus.PASSED).length);
      expect(cov.failed).toBe(checks.filter((c) => c.status === CheckStatus.FAILED).length);
      expect(cov.blocked).toBe(0);
      expect(cov.skipped).toBe(0);
      expect(cov.error).toBe(0);
      expect(cov.blockers).toBe(0);
      expect(cov.executed_pct).toBe(100);

      // by_domain buckets consistent
      const byDomain = cov.by_domain as Record<string, { planned: number; passed: number; failed: number; blocked: number; skipped: number; error: number; blockers: number }>;
      const expectedByDomain: typeof byDomain = {};
      for (const c of checks) {
        const b = (expectedByDomain[c.domain] ??= { planned: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, error: 0, blockers: 0 });
        b.planned += 1;
        if (c.status === CheckStatus.PASSED) b.passed += 1;
        else if (c.status === CheckStatus.FAILED) b.failed += 1;
      }
      expect(byDomain).toEqual(expectedByDomain);

      // Evidence summary totals match finalized store
      expect(report.evidence).toEqual({ directory: manifest.summary.directory, summary: manifest.summary });
      expect(manifest.summary.count).toBe(evidenceStore.getEntries().length);
      expect(manifest.summary.count).toBe(manifest.evidence.length);

      // checks<->findings mutual consistency in report
      const reportChecks = report.checks as Array<{ id: string; finding_ids: string[]; evidence: string[] }>;
      const reportFindings = report.findings as Array<{ id: string; check_id: string; evidence: string[] }>;
      for (const rc of reportChecks) {
        for (const fid of rc.finding_ids) {
          const rf = reportFindings.find((f) => f.id === fid);
          expect(rf, `report finding ${fid}`).toBeDefined();
          expect(rf!.check_id).toBe(rc.id);
        }
      }
      for (const rf of reportFindings) {
        const rc = reportChecks.find((c) => c.id === rf.check_id);
        expect(rc).toBeDefined();
        expect(rc!.finding_ids).toContain(rf.id);
      }
    });
  });
});
