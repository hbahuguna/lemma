import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  CorruptStateError,
  DomainPhaseName,
  EvidenceStore,
  Orchestrator,
  PhaseStatus,
  RELEASE_CONFIDENCE,
  RunStatus,
  Severity,
  StateStore,
  Strength,
  buildReport,
  decisionForState,
  normalizeTarget,
  scoreConfidence,
  type Check,
  type Finding,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-failure-injection-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const target = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });

function baseCheck(id: string, overrides: Partial<Check> = {}): Check {
  return {
    id,
    title: overrides.title ?? id,
    domain: overrides.domain ?? "functional",
    persona: overrides.persona ?? "p",
    kind: overrides.kind ?? "static",
    intent: overrides.intent ?? "i",
    expected: overrides.expected ?? "e",
    base_weight: overrides.base_weight ?? 1,
    weight: overrides.weight ?? overrides.base_weight ?? 1,
    status: overrides.status ?? CheckStatus.PLANNED,
    actual: overrides.actual ?? "",
    evidence: overrides.evidence ?? [],
    finding_ids: overrides.finding_ids ?? [],
    skip_reason: overrides.skip_reason ?? "",
    started_at: overrides.started_at ?? null,
    completed_at: overrides.completed_at ?? null,
    metadata: overrides.metadata ?? {},
  };
}

function finding(overrides: Partial<Finding> & Pick<Finding, "id" | "check_id" | "severity">): Finding {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    severity: overrides.severity,
    domain: overrides.domain ?? "security",
    persona: overrides.persona ?? "p",
    strength: overrides.strength ?? Strength.SOURCE_PROVEN,
    consequence: overrides.consequence ?? "c",
    location: overrides.location ?? "",
    reproduction: overrides.reproduction ?? "",
    evidence: overrides.evidence ?? [],
    remediation: overrides.remediation ?? "",
    verification: overrides.verification ?? "",
    check_id: overrides.check_id,
    created_at: overrides.created_at ?? "2026-11-14T00:00:00Z",
    tags: overrides.tags ?? [],
    fingerprint: overrides.fingerprint ?? `${overrides.check_id}:${overrides.id}`,
    suppressed: overrides.suppressed ?? false,
    suppression_owner: overrides.suppression_owner ?? "",
    suppression_reason: overrides.suppression_reason ?? "",
    suppression_ticket: overrides.suppression_ticket ?? "",
    suppression_expires_at: overrides.suppression_expires_at ?? "",
  };
}

describe("LEM-126 state, evidence, and kill-switch failure injection", () => {
  it("corrupt progress produces typed error and preserves file for recovery", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      await store.ensure();

      const goodState = {
        run_id: "run-1",
        workflow_id: RELEASE_CONFIDENCE.id,
        workflow_version: RELEASE_CONFIDENCE.version,
        status: RunStatus.COMPLETED,
        target: { raw: ".", kind: "directory", resolved: "/repo" },
        intent: "verify",
        phases: [],
        checks: [],
        findings: [],
        invalid_findings: [],
        blockers: [],
        confidence: { score: 0, band: "none", coverage: 0, rationale: "", limitations: [], penalties: {}, domain_scores: {}, breakdown: {}, gate: { status: "fail", reasons: [], policy: "advisory-v1" } },
        options: {},
        evidence_dir: ".lemma/evidence/run-1",
        started_at: "2026-11-14T00:00:00Z",
        updated_at: "2026-11-14T00:00:00Z",
        completed_at: "2026-11-14T00:00:01Z",
        halted_reason: "",
        error: "",
      };
      await store.saveProgress(goodState);
      const original = await readFile(store.progressPath, "utf8");

      // Preserve an existing report artifact for recovery context.
      const reportPath = path.join(store.lemmaDir, "report.json");
      await writeFile(reportPath, JSON.stringify({ status: "completed", decision: { decision: "hold" } }, null, 2), "utf8");

      await writeFile(store.progressPath, "{not valid json", "utf8");
      await expect(store.loadProgress()).rejects.toBeInstanceOf(CorruptStateError);
      expect(await readFile(store.progressPath, "utf8")).toBe("{not valid json");
      expect(await readFile(reportPath, "utf8")).toContain("\"status\": \"completed\"");

      await writeFile(store.progressPath, original, "utf8");
      const loaded = await store.loadProgress<{ run_id: string; status: string }>();
      expect(loaded.run_id).toBe("run-1");
      expect(loaded.status).toBe(RunStatus.COMPLETED);
    });
  });

  it("failed evidence write does not produce a passing/ship report", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: (ctx) => {
            ctx.state.checks = [baseCheck("c1")];
          },
          test_planning: () => {},
          execution: (ctx) => {
            const c1 = ctx.state.checks[0];
            if (c1) {
              c1.status = CheckStatus.PASSED;
              c1.actual = "ok";
            }
          },
          evidence_collection: () => {
            throw new Error("simulated evidence write failure");
          },
          confidence_scoring: () => {},
        },
      });

      await expect(orch.run({ target, intent: "ship", workflow: RELEASE_CONFIDENCE, maxChecks: 5 })).rejects.toThrow(
        "simulated evidence write failure",
      );

      const progress = await store.loadProgress<Record<string, unknown>>();
      expect(progress.status).toBe(RunStatus.FAILED);
      expect(progress.error).toBe("simulated evidence write failure");
      expect(progress.status).not.toBe(RunStatus.COMPLETED);

      const report = buildReport(
        {
          ...(progress as any),
          checks: (progress.checks as any[]) ?? [],
          findings: (progress.findings as any[]) ?? [],
          invalid_findings: (progress.invalid_findings as any[]) ?? [],
          blockers: (progress.blockers as any[]) ?? [],
          personas: (progress.personas as any[]) ?? [],
          contract_failures: (progress.contract_failures as any) ?? {},
          contract_failure_streaks: (progress.contract_failure_streaks as any) ?? {},
          degraded_personas: (progress.degraded_personas as any[]) ?? [],
          confidence: (progress.confidence as any) ?? { score: 0, band: "none", coverage: 0, rationale: "", limitations: [], penalties: {}, domain_scores: {}, breakdown: {}, gate: { status: "fail", reasons: [], policy: "advisory-v1" } },
          phases: (progress.phases as any[]) ?? [],
          kill_switch: (progress.kill_switch as any) ?? { armed: true, threshold: "critical", triggered: false, reason: "", triggered_at: null, finding_id: "", manual: false },
          options: (progress.options as any) ?? {},
        } as any,
        RELEASE_CONFIDENCE,
        { directory: ".lemma/evidence/run", count: 0, by_kind: {}, total_bytes: 0, manifest: "" },
        "2026-11-14T00:00:00Z",
      );
      expect((report.decision as { decision: string }).decision).toBe("hold");
      expect((report.decision as { decision: string }).decision).not.toBe("ship");
    });
  });

  it("kill during evidence collection writes halted hold report semantics", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: () => {},
          test_planning: (ctx) => {
            ctx.state.checks = [baseCheck("c1", { status: CheckStatus.PASSED, actual: "ok" })];
          },
          execution: () => {},
          evidence_collection: async (ctx) => {
            await ctx.halt("injected kill during evidence", true);
          },
          confidence_scoring: () => {},
        },
      });

      const state = await orch.run({ target, intent: "ship", workflow: RELEASE_CONFIDENCE, maxChecks: 5 });
      expect(state.status).toBe(RunStatus.HALTED);
      expect(state.kill_switch.triggered).toBe(true);
      expect(state.halted_reason.toLowerCase()).toContain("kill");
      expect(state.phases.find((p) => p.name === DomainPhaseName.EVIDENCE_COLLECTION)?.status).toBe(
        PhaseStatus.HALTED,
      );
      expect(state.phases.find((p) => p.name === DomainPhaseName.CONFIDENCE_SCORING)?.status).toBe(
        PhaseStatus.SKIPPED,
      );

      const report = buildReport(
        state as any,
        RELEASE_CONFIDENCE,
        { directory: ".lemma/evidence/run", count: 0, by_kind: {}, total_bytes: 0, manifest: "" },
        "2026-11-14T00:00:00Z",
      );
      expect(report.status).toBe(RunStatus.HALTED);
      expect((report.decision as { decision: string }).decision).toBe("hold");
      expect(String(report.halted_reason ?? "").toLowerCase()).toContain("kill");
    });
  });

  it("kill switch failure is fail-closed (halted hold with capped confidence)", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: () => {},
          test_planning: (ctx) => {
            ctx.state.checks = [baseCheck("c1", { status: CheckStatus.PLANNED })];
          },
          execution: async (ctx) => {
            const c1 = ctx.state.checks[0];
            if (c1) {
              c1.status = CheckStatus.FAILED;
              c1.actual = "critical issue";
              c1.finding_ids = ["f1"];
            }
            ctx.state.findings = [
              finding({
                id: "f1",
                check_id: "c1",
                severity: Severity.CRITICAL,
                title: "Critical finding",
                domain: "security",
              }),
            ];
            ctx.state.confidence = scoreConfidence(ctx.state.checks, ctx.state.findings, {
              halted: true,
              killReason: "critical finding threshold reached",
            });
            await ctx.halt("critical finding threshold reached", false);
          },
          evidence_collection: () => {},
          confidence_scoring: () => {},
        },
      });

      const state = await orch.run({ target, intent: "ship", workflow: RELEASE_CONFIDENCE, maxChecks: 5 });
      expect(state.status).toBe(RunStatus.HALTED);
      expect(state.kill_switch.triggered).toBe(true);
      expect(decisionForState(state).decision).toBe("hold");

      // Fail-closed: halted confidence capped and cannot be a pass/ship.
      expect(state.confidence.score).toBeLessThanOrEqual(25.0);
      expect(state.confidence.gate?.status).not.toBe("pass");

      const report = buildReport(
        state as any,
        RELEASE_CONFIDENCE,
        { directory: ".lemma/evidence/run", count: 0, by_kind: {}, total_bytes: 0, manifest: "" },
        "2026-11-14T00:00:00Z",
      );
      expect((report.decision as { decision: string }).decision).toBe("hold");
      expect(Number((report.confidence as { score: number }).score)).toBeLessThanOrEqual(25.0);
    });
  });

  it("partial manifest is rejected by evidence verify as tampered", async () => {
    await withTempDir(async (dir) => {
      const store = new EvidenceStore(dir, "run-partial");
      await store.init();
      await store.saveText("note", "hello", "text", "", "static.tests");
      await store.finalize({ status: "completed" });

      const data = await readFile(store.manifestPath, "utf8");
      await writeFile(store.manifestPath, data.slice(0, Math.floor(data.length / 2)), "utf8");

      const result = await store.verify();
      expect(result.tampered).toBe(true);
      expect(result.signature_valid).toBe(false);
      expect(result.alert.level).toBe("error");
    });
  });
});
