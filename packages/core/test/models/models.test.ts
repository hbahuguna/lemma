import { describe, expect, it } from "vitest";

import {
  CheckOutcome,
  CheckStatus,
  DomainPhaseName,
  MODEL_SCHEMA_VERSION,
  PhaseStatus,
  RunStatus,
  Severity,
  Strength,
  clampSeverity,
  createFinding,
  createRunState,
  normalizeBlocker,
  normalizeCheck,
  normalizeConfidence,
  normalizeFinding,
  normalizeInvalidFinding,
  normalizeKillSwitch,
  normalizePhase,
  normalizeRisk,
  normalizeRunState,
  normalizeTarget,
  severityRank,
  makeDeterminism,
  resetDeterminism,
  setDeterminism,
} from "../../src/index.js";

describe("LEM-013 domain models and normalization", () => {
  it("implements domain enums/constants and severity helpers with assay-compatible values", () => {
    expect(MODEL_SCHEMA_VERSION).toBe("1.0");
    expect(RunStatus).toMatchObject({
      RUNNING: "running",
      COMPLETED: "completed",
      HALTED: "halted",
      FAILED: "failed",
    });
    expect(DomainPhaseName).toMatchObject({
      RISK_ANALYSIS: "risk_analysis",
      TEST_PLANNING: "test_planning",
      EXECUTION: "execution",
      EVIDENCE_COLLECTION: "evidence_collection",
      CONFIDENCE_SCORING: "confidence_scoring",
    });
    expect(PhaseStatus.RUNNING).toBe("running");
    expect(CheckStatus).toMatchObject({
      PLANNED: "planned",
      RUNNING: "running",
      PASSED: "passed",
      FAILED: "failed",
      BLOCKED: "blocked",
      SKIPPED: "skipped",
      ERROR: "error",
    });
    expect(Severity.CRITICAL).toBe("critical");
    expect(Strength.SOURCE_PROVEN).toBe("source_proven");
    expect(severityRank(Severity.CRITICAL)).toBe(5);
    expect(severityRank("high")).toBe(4);
    expect(severityRank("unknown")).toBe(0);
    expect(clampSeverity("CRITICAL")).toBe("critical");
    expect(clampSeverity("nope")).toBe("medium");
    expect(clampSeverity(undefined)).toBe("medium");
  });

  it("normalizes core records with defaults/coercion and preserves stable JSON round-trips", () => {
    const target = normalizeTarget({ raw: "/repo", kind: "directory", resolved: "/repo" });
    expect(target.source ?? null).toBeNull();
    expect(JSON.parse(JSON.stringify(target))).toEqual({
      raw: "/repo",
      kind: "directory",
      resolved: "/repo",
      source: null,
    });

    const risk = normalizeRisk({ id: "r1", title: "Risk", priority: "high", weight_multiplier: "2" });
    expect(risk.domain).toBe("functional");
    expect(risk.weight_multiplier).toBe(2);
    expect(risk.evidence).toEqual([]);

    const finding = normalizeFinding({
      id: "f1",
      title: "Finding",
      severity: "high",
      domain: "security",
      persona: "security",
      strength: "source_proven",
      consequence: "bad",
      evidence: ["a"],
      tags: ["t"],
      suppressed: true,
      created_at: "2026-11-14T00:00:00Z",
    });
    expect(finding.location).toBe("");
    expect(finding.suppressed).toBe(true);
    expect(finding.tags).toEqual(["t"]);
    const findingRt = normalizeFinding(JSON.parse(JSON.stringify(finding)));
    expect(findingRt).toEqual(finding);

    const invalid = normalizeInvalidFinding({ id: "i1", persona: "p", check_id: "c", errors: ["e"], payload: { x: 1 } });
    expect(invalid.contract).toBe("persona_output_schema");
    expect(invalid.payload).toEqual({ x: 1 });

    const blocker = normalizeBlocker({ id: "b1", persona: "p", check_id: "c", attempted_action: "a", boundary: "b", covered_elsewhere: 1 });
    expect(blocker.covered_elsewhere).toBe(true);
    expect(blocker.unblock_evidence).toEqual([]);

    const check = normalizeCheck({ id: "c1", title: "C", domain: "d", persona: "p", kind: "static", intent: "i", expected: "e", base_weight: 3 });
    expect(check.status).toBe(CheckStatus.PLANNED);
    expect(check.weight).toBe(3);
    expect(check.metadata).toEqual({});

    const phase = normalizePhase({ name: "execution" });
    expect(phase.title).toBe("execution");
    expect(phase.status).toBe(PhaseStatus.PENDING);
    expect(phase.details).toEqual({});

    const confidence = normalizeConfidence({ score: "50.5", band: "medium", penalties: { gap: "2" } });
    expect(confidence.score).toBe(50.5);
    expect(confidence.penalties.gap).toBe(2);
    expect(confidence.limitations).toEqual([]);

    const ks = normalizeKillSwitch({});
    expect(ks.armed).toBe(true);
    expect(ks.threshold).toBe("critical");
    expect(ks.triggered).toBe(false);
    expect(ks.manual).toBe(false);
  });

  it("normalizes RunState domain objects with deterministic defaults and round-trip stability", () => {
    const det = makeDeterminism({ seed: 42, clockMode: "frozen", frozenClock: "2026-11-14T00:00:00Z" });
    const prev = setDeterminism(det);
    try {
      const state = createRunState({ target: { raw: ".", kind: "directory", resolved: "/tmp/repo" }, intent: "ship" });
      expect(state.run_id.startsWith("run-")).toBe(true);
      expect(state.status).toBe(RunStatus.RUNNING);
      expect(state.current_phase).toBe(DomainPhaseName.RISK_ANALYSIS);
      expect(state.started_at).toBe("2026-11-14T00:00:00Z");
      expect(state.schema_version).toBe(MODEL_SCHEMA_VERSION);
      expect(state.kill_switch.armed).toBe(true);
      expect(state.confidence.band).toBe("unscored");

      const f = createFinding({ id: "f-1", title: "T" });
      expect(f.created_at).toBe("2026-11-14T00:00:00Z");
      expect(f.severity).toBe(Severity.MEDIUM);

      const withChildren = normalizeRunState({
        ...state,
        findings: [f],
        checks: [{ id: "c1", title: "C", domain: "d", persona: "p", kind: "static", intent: "i", expected: "e", base_weight: 1, weight: "2" }],
        contract_failures: { "p:a": "3" },
      });
      expect(withChildren.findings[0]!.id).toBe("f-1");
      expect(withChildren.checks[0]!.weight).toBe(2);
      expect(withChildren.contract_failures["p:a"]).toBe(3);

      const rt = normalizeRunState(JSON.parse(JSON.stringify(withChildren)));
      expect(rt).toEqual(withChildren);
    } finally {
      resetDeterminism(prev);
    }
  });

  it("provides outcome drafts with CheckOutcome addFinding/addBlocker behavior and clampSeverity", () => {
    const out = new CheckOutcome({ actual: "ok", evidence: ["ev1"] });
    expect(out.status).toBe(CheckStatus.PASSED);
    out.addFinding("Broken", "high", "security", "impact", "loc", "repro", Strength.SOURCE_PROVEN, "fix", "verify", ["tag"]);
    expect(out.status).toBe(CheckStatus.FAILED);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.evidence).toEqual(["ev1"]);
    expect(out.findings[0]!.strength).toBe(Strength.SOURCE_PROVEN);

    const blocked = new CheckOutcome();
    blocked.addFinding("x", "low", "d", "c");
    blocked.addBlocker("do thing", "boundary", ["need x"], true, ["other.check"]);
    expect(blocked.status).toBe(CheckStatus.BLOCKED);
    expect(blocked.findings).toEqual([]);
    expect(blocked.blocker!.attempted_action).toBe("do thing");
    expect(blocked.blocker!.covered_elsewhere).toBe(true);

    expect(clampSeverity("")).toBe(Severity.MEDIUM);
  });
});
