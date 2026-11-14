import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  DomainPhaseName,
  EvidenceStore,
  Orchestrator,
  PHASE_ORDER,
  PhaseStatus,
  RELEASE_CONFIDENCE,
  RunStatus,
  Severity,
  StateStore,
  Strength,
  buildReport,
  isValidReport,
  normalizeTarget,
  registryFingerprint,
  scoreConfidence,
  validateReport,
  type Check,
  type Finding,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-conf-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readEvents(store: StateStore): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(store.eventsPath, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const target = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });
const seeded = { seed: 4242, clockMode: "frozen" as const, frozenClock: "2026-11-14T00:00:00Z" };

function baseCheck(overrides: Partial<Check> & Pick<Check, "id">): Check {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
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

describe("LEM-026 orchestrator conformance suite", () => {
  it("runs full deterministic flow with phase/budget/persistence invariants and produces verified evidence + schema-valid report", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const seen: string[] = [];
      let evidenceStore: EvidenceStore | null = null;
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: (ctx) => {
            seen.push(ctx.phase.name);
            ctx.state.risks = [{ id: "r1", title: "risk", priority: "high", domain: "security", consequence: "c", evidence: [], weight_multiplier: 1, source: "analysis", status: "open" }];
          },
          test_planning: (ctx) => {
            seen.push(ctx.phase.name);
            expect(ctx.budget.maxChecks).toBe(2);
            ctx.state.checks = [
              baseCheck({ id: "c1", domain: "functional" }),
              baseCheck({ id: "c2", domain: "security" }),
            ];
          },
          execution: async (ctx) => {
            seen.push(ctx.phase.name);
            ctx.state.checks = ctx.state.checks.map((c) => ({ ...c, status: CheckStatus.PASSED, actual: "ok" }));
            evidenceStore = new EvidenceStore(dir, ctx.state.run_id);
            await evidenceStore.init();
            const p = await evidenceStore.saveText("c1.txt", "evidence", "text", "c1 artifact", "c1");
            const c1 = ctx.state.checks.find((c) => c.id === "c1");
            if (c1) c1.evidence = [p];
            await evidenceStore.checkpoint();
          },
          evidence_collection: async (ctx) => {
            seen.push(ctx.phase.name);
            if (!evidenceStore) throw new Error("missing evidence store");
            const verification = await evidenceStore.verify();
            ctx.phase.details = { verification };
            ctx.phase.summary = verification.tampered ? "tampered" : "verified";
          },
          confidence_scoring: async (ctx) => {
            seen.push(ctx.phase.name);
            ctx.state.confidence = scoreConfidence(ctx.state.checks, ctx.state.findings, { halted: false });
            if (evidenceStore) {
              await evidenceStore.finalize({ run_id: ctx.state.run_id, status: ctx.state.status });
            }
          },
        },
      });

      const result = await orch.run({
        target,
        intent: "ship",
        workflow: RELEASE_CONFIDENCE,
        maxChecks: 2,
        ...seeded,
      });

      expect(seen).toEqual([...PHASE_ORDER]);
      expect(result.status).toBe(RunStatus.COMPLETED);
      expect(result.phases.map((p) => p.name)).toEqual([...PHASE_ORDER]);
      expect(result.phases.every((p) => p.status === PhaseStatus.COMPLETED)).toBe(true);
      expect(result.current_phase).toBe(DomainPhaseName.CONFIDENCE_SCORING);
      expect(result.options.maxChecks).toBe(2);
      expect(result.options.registry_fingerprint).toBe(registryFingerprint(null));

      const loaded = await store.loadProgress<Record<string, unknown>>();
      expect(loaded.status).toBe(RunStatus.COMPLETED);
      const history = await store.loadHistory();
      expect(history.runs[0]?.run_id).toBe(result.run_id);
      expect(history.runs[0]?.status).toBe(RunStatus.COMPLETED);
      const events = await readEvents(store);
      expect(events.some((e) => e.event === "run_started")).toBe(true);
      expect(events.filter((e) => e.event === "phase_completed")).toHaveLength(PHASE_ORDER.length);
      expect(events.some((e) => e.event === "run_finished" && e.status === RunStatus.COMPLETED)).toBe(true);

      expect(evidenceStore).toBeTruthy();
      const manifest = await evidenceStore!.finalize({ run_id: result.run_id, status: RunStatus.COMPLETED });
      const verification = await evidenceStore!.verify();
      expect(verification.tampered).toBe(false);
      expect(verification.signature_valid).toBe(true);
      expect(manifest.run_id).toBe(result.run_id);
      expect(Array.isArray(manifest.evidence)).toBe(true);
      expect(existsSync(evidenceStore!.manifestPath)).toBe(true);

      const report = buildReport(result, RELEASE_CONFIDENCE, evidenceStore!.summary() as unknown as Record<string, unknown>, "2026-11-14T00:00:00Z");
      expect(validateReport(report)).toEqual([]);
      expect(isValidReport(report)).toBe(true);
      expect(report.status).toBe(RunStatus.COMPLETED);
      expect((report.decision as { decision: string }).decision).toBeDefined();
      expect(report.run_id).toBe(result.run_id);
      expect((report.evidence as { summary: unknown }).summary).toBeTruthy();
    });
  });

  it("halts on kill/handler trigger, skips remaining phases/checks, and report/confidence reflect hold semantics without auto-resume", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      let evidenceCollectionRan = false;
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: () => {},
          test_planning: (ctx) => {
            ctx.state.checks = [baseCheck({ id: "c1", status: CheckStatus.PLANNED }), baseCheck({ id: "c2", status: CheckStatus.PLANNED })];
          },
          execution: async (ctx) => {
            // complete one check, then halt
            const c1 = ctx.state.checks[0];
            if (c1) {
              c1.status = CheckStatus.PASSED;
              c1.actual = "ok";
              c1.completed_at = "2026-11-14T00:00:00Z";
            }
            ctx.state.confidence = scoreConfidence(ctx.state.checks, ctx.state.findings, { halted: true });
            await ctx.halt("critical finding threshold reached", false);
          },
          evidence_collection: () => {
            evidenceCollectionRan = true;
          },
          confidence_scoring: () => {},
        },
      });

      const result = await orch.run({ target, intent: "ship", workflow: RELEASE_CONFIDENCE, maxChecks: 5, ...seeded });
      expect(evidenceCollectionRan).toBe(false);
      expect(result.status).toBe(RunStatus.HALTED);
      expect(result.kill_switch.triggered).toBe(true);
      expect(result.halted_reason.length).toBeGreaterThan(0);
      expect(result.phases.find((p) => p.name === DomainPhaseName.EXECUTION)?.status).toBe(PhaseStatus.HALTED);
      expect(result.phases.find((p) => p.name === DomainPhaseName.EVIDENCE_COLLECTION)?.status).toBe(PhaseStatus.SKIPPED);
      expect(result.phases.find((p) => p.name === DomainPhaseName.CONFIDENCE_SCORING)?.status).toBe(PhaseStatus.SKIPPED);
      // remaining planned/running checks are marked skipped by halt handling
      expect(result.checks.some((c) => c.status === CheckStatus.SKIPPED)).toBe(true);

      const history = await store.loadHistory();
      expect(history.runs[0]?.status).toBe(RunStatus.HALTED);
      const events = await readEvents(store);
      expect(events.some((e) => e.event === "kill_switch_triggered")).toBe(true);
      expect(events.some((e) => e.event === "run_finished" && e.status === RunStatus.HALTED)).toBe(true);

      // No auto-resume: progress remains halted
      const loaded = await store.loadProgress<Record<string, unknown>>();
      expect(loaded.status).toBe(RunStatus.HALTED);

      const report = buildReport(result, RELEASE_CONFIDENCE, { directory: ".lemma/evidence/x", count: 0, by_kind: {}, total_bytes: 0, manifest: "" }, "2026-11-14T00:00:00Z");
      expect(validateReport(report)).toEqual([]);
      expect((report.decision as { decision: string }).decision).toBe("hold");
      expect(report.halted_reason).toBeTruthy();
      expect((report.confidence as { gate: { status: string } }).gate.status).toBeDefined();
    });
  });

  it("resumes after simulated crash, reruns only unfinished checks, preserves completed evidence/findings, and finalizes valid report", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const runId = "run-conf-crash";
      const fp = registryFingerprint(null);

      // Seed a crashed/incomplete run with completed evidence and unfinished checks.
      const ev = new EvidenceStore(dir, runId);
      await ev.init();
      const completedPath = await ev.saveText("c1.txt", "ok", "text", "completed", "c1");
      await ev.checkpoint();

      const crashed = {
        schema_version: "1.0",
        run_id: runId,
        workflow_id: RELEASE_CONFIDENCE.id,
        workflow_version: RELEASE_CONFIDENCE.version,
        target: { raw: ".", kind: "directory", resolved: "/repo", source: null },
        intent: "ship",
        status: RunStatus.FAILED,
        current_phase: DomainPhaseName.EXECUTION,
        phases: [
          { name: "risk_analysis", title: "Risk Analysis", status: PhaseStatus.COMPLETED, summary: "", details: {}, started_at: "t", completed_at: "t" },
          { name: "test_planning", title: "Test Planning", status: PhaseStatus.COMPLETED, summary: "", details: {}, started_at: "t", completed_at: "t" },
          { name: "execution", title: "Execution", status: PhaseStatus.RUNNING, summary: "", details: {}, started_at: "t", completed_at: null },
          { name: "evidence_collection", title: "Evidence Collection", status: PhaseStatus.PENDING, summary: "", details: {}, started_at: null, completed_at: null },
          { name: "confidence_scoring", title: "Confidence Scoring", status: PhaseStatus.PENDING, summary: "", details: {}, started_at: null, completed_at: null },
        ],
        risks: [],
        checks: [
          baseCheck({ id: "c1", status: CheckStatus.PASSED, actual: "done", evidence: [completedPath], finding_ids: ["f1"] }),
          baseCheck({ id: "c2", status: CheckStatus.ERROR, actual: "boom", finding_ids: ["f2"] }),
          baseCheck({ id: "c3", status: CheckStatus.RUNNING }),
          baseCheck({ id: "c4", status: CheckStatus.PLANNED }),
        ],
        findings: [
          finding({ id: "f1", check_id: "c1", severity: Severity.LOW, fingerprint: "fp-f1" }),
          finding({ id: "f2", check_id: "c2", severity: Severity.MEDIUM, fingerprint: "fp-f2" }),
        ],
        invalid_findings: [],
        blockers: [
          { id: "b1", persona: "p", check_id: "c1", attempted_action: "", boundary: "x", unblock_evidence: [], covered_elsewhere: false, covered_by: [], recorded_at: "t" },
          { id: "b2", persona: "p", check_id: "c2", attempted_action: "", boundary: "x", unblock_evidence: [], covered_elsewhere: false, covered_by: [], recorded_at: "t" },
        ],
        contract_failures: {},
        contract_failure_streaks: {},
        degraded_personas: [],
        confidence: { score: 0, band: "unscored", coverage: 0, rationale: "", limitations: [], penalties: {}, domain_scores: {}, breakdown: {}, gate: {} },
        kill_switch: { armed: true, threshold: "critical", triggered: false, reason: "", triggered_at: null, finding_id: "", manual: false },
        inventory: {},
        personas: [],
        options: { maxChecks: 10, registry_fingerprint: fp, plugin_registry_fingerprint: fp },
        evidence_dir: `.lemma/evidence/${runId}`,
        started_at: "2026-11-14T00:00:00Z",
        updated_at: "2026-11-14T00:00:00Z",
        completed_at: null,
        halted_reason: "",
        error: "simulated crash",
        seed: null,
        clock_mode: "real",
      };
      await store.saveProgress(crashed);

      const reran: string[] = [];
      const orch = new Orchestrator({
        store,
        handlers: {
          execution: (ctx) => {
            for (const c of ctx.state.checks) {
              if ([CheckStatus.PLANNED, CheckStatus.RUNNING, CheckStatus.ERROR].includes(c.status as typeof CheckStatus.PLANNED)) {
                reran.push(c.id);
                c.status = CheckStatus.PASSED;
                c.actual = "reran";
              }
            }
          },
          evidence_collection: async (ctx) => {
            const evidence = new EvidenceStore(dir, ctx.state.run_id);
            await evidence.init();
            const v = await evidence.verify();
            ctx.phase.details = { verification: v };
            await evidence.finalize({ run_id: ctx.state.run_id, status: ctx.state.status });
          },
          confidence_scoring: (ctx) => {
            ctx.state.confidence = scoreConfidence(ctx.state.checks, ctx.state.findings, { halted: false });
          },
        },
      });

      const resumed = await orch.resume({ target, intent: "ship", workflow: RELEASE_CONFIDENCE, maxChecks: 10 });
      expect(resumed.status).toBe(RunStatus.COMPLETED);
      expect(new Set(reran)).toEqual(new Set(["c2", "c3", "c4"]));
      expect(reran).not.toContain("c1");

      const c1 = resumed.checks.find((c) => c.id === "c1");
      expect(c1?.status).toBe(CheckStatus.PASSED);
      expect(c1?.evidence).toContain(completedPath);
      expect(resumed.findings.some((f) => f.id === "f1" && f.check_id === "c1")).toBe(true);
      expect(resumed.findings.some((f) => f.id === "f2")).toBe(false);
      expect(resumed.blockers.some((b) => b.id === "b1")).toBe(true);
      expect(resumed.blockers.some((b) => b.id === "b2")).toBe(false);

      const evidence = new EvidenceStore(dir, resumed.run_id);
      await evidence.init();
      const manifest = await evidence.finalize({ run_id: resumed.run_id, status: resumed.status });
      const verification = await evidence.verify();
      expect(verification.tampered).toBe(false);
      expect(manifest.evidence.some((e) => e.path === completedPath)).toBe(true);

      const report = buildReport(resumed, RELEASE_CONFIDENCE, evidence.summary() as unknown as Record<string, unknown>, "2026-11-14T00:00:00Z");
      expect(validateReport(report)).toEqual([]);
      expect(isValidReport(report)).toBe(true);
      expect(report.status).toBe(RunStatus.COMPLETED);
    });
  });
});
