import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  Orchestrator,
  RELEASE_CONFIDENCE,
  RunStatus,
  StateStore,
  buildReport,
  createRunState,
  draftPayload,
  findingFingerprint,
  loadPersonas,
  makeDeterminism,
  normalizeTarget,
  quarantineFinding,
  rebuildContractHealth,
  recordCheckFindings,
  resetDeterminism,
  scoreConfidence,
  setDeterminism,
  type Check,
  type Persona,
} from "../../src/index.js";

const PERSONAS_DIR = fileURLToPath(new URL("../../../personas", import.meta.url));
const TARGET = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });
const FROZEN = "2026-11-15T00:00:00Z";
const SEEDED = { seed: 4242, clockMode: "frozen" as const, frozenClock: FROZEN };
const SENSITIVE_VALUE = "not-a-real-token-value";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-invalid-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function withFrozenDeterminism<T>(fn: () => T): T {
  const previous = setDeterminism(
    makeDeterminism({ seed: 7, clockMode: "frozen", frozenClock: FROZEN }),
  );
  try {
    return fn();
  } finally {
    resetDeterminism(previous);
  }
}

function baseCheck(overrides: Partial<Check> & Pick<Check, "id">): Check {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    domain: overrides.domain ?? "functional",
    persona: overrides.persona ?? "functional",
    kind: overrides.kind ?? "static",
    intent: overrides.intent ?? "verify",
    expected: overrides.expected ?? "no contract violation",
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

function publicPersona(persona: Persona): Record<string, unknown> {
  return {
    id: persona.id,
    name: persona.name,
    version: persona.version,
    domains: [...persona.domains],
    tools: [...persona.tools],
    checks: [...persona.checks],
  };
}

function validDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Login button is unreachable",
    severity: "high",
    domain: "functional",
    strength: "observed",
    consequence: "A user cannot sign in.",
    location: "src/login.ts:42",
    reproduction: "Open the login page and press Enter.",
    evidence: ["evidence/step.txt"],
    remediation: "Wire the keydown handler.",
    verification: "Press Enter on the login form.",
    tags: ["login"],
    ...overrides,
  };
}

function missingVerificationDraft(): Record<string, unknown> {
  const draft = validDraft({ severity: "critical" });
  delete draft.verification;
  return draft;
}

interface ScenarioResult {
  result: Awaited<ReturnType<Orchestrator["run"]>>;
  report: Record<string, unknown>;
  store: StateStore;
  logs: string[];
}

async function runScenario(
  dir: string,
  drafts: readonly unknown[],
  options: { killOnCritical?: boolean } = {},
): Promise<ScenarioResult> {
  const personas = await loadPersonas(PERSONAS_DIR);
  const byId = new Map(personas.map((persona) => [persona.id, persona]));
  const store = new StateStore(dir);
  const logs: string[] = [];
  const orch = new Orchestrator({
    store,
    handlers: {
      risk_analysis: () => {},
      test_planning: (ctx) => {
        ctx.state.personas = personas.map(publicPersona);
        ctx.state.checks = [
          baseCheck({ id: "contract.probe", persona: "functional" }),
          baseCheck({ id: "contract.control", persona: "functional", domain: "reliability" }),
        ];
      },
      execution: async (ctx) => {
        const check = ctx.state.checks.find((item) => item.id === "contract.probe");
        if (!check) throw new Error("missing planned check");
        const controlCheck = ctx.state.checks.find((item) => item.id === "contract.control");
        if (controlCheck) {
          controlCheck.status = CheckStatus.PASSED;
          controlCheck.actual = "ok";
        }
        check.status = CheckStatus.FAILED;
        check.actual = "probe produced finding drafts";
        const recorded = recordCheckFindings(
          ctx.state,
          check,
          drafts,
          byId.get("functional"),
          { log: (message) => logs.push(message) },
        );
        await ctx.appendEvent({
          event: "check_completed",
          check_id: check.id,
          findings: recorded.findings.length,
          invalid_findings: recorded.invalidCount,
        });
        if (options.killOnCritical) {
          for (const finding of recorded.findings) {
            if (finding.severity === "critical") {
              await ctx.halt("critical finding threshold reached", false);
              break;
            }
          }
        }
      },
      evidence_collection: () => {},
      confidence_scoring: (ctx) => {
        ctx.state.confidence = scoreConfidence(ctx.state.checks, ctx.state.findings, {
          halted: ctx.state.kill_switch.triggered,
          killReason: ctx.state.kill_switch.reason,
        });
      },
    },
  });

  const result = await orch.run({
    target: TARGET,
    intent: "verify quarantine",
    workflow: RELEASE_CONFIDENCE,
    maxChecks: 1,
    ...SEEDED,
  });
  const report = buildReport(result, RELEASE_CONFIDENCE, {}, FROZEN);
  return { result, report, store, logs };
}

describe("LEM-045 invalid-finding quarantine and degraded streaks", () => {
  it("quarantines invalid findings without scoring, linking, or killing the run", async () => {
    await withTempDir(async (dir) => {
      const invalidDrafts = [
        validDraft({ severity: "blocker", consequence: `leaked token=${SENSITIVE_VALUE}` }),
        validDraft({ tags: { tag: "login" } }),
        missingVerificationDraft(),
      ];
      const invalidRun = await runScenario(dir, invalidDrafts, { killOnCritical: true });

      expect(invalidRun.result.status).toBe(RunStatus.COMPLETED);
      expect(invalidRun.result.kill_switch.triggered).toBe(false);
      expect(invalidRun.result.findings).toEqual([]);
      expect(invalidRun.result.invalid_findings).toHaveLength(3);

      const check = invalidRun.result.checks[0];
      expect(check?.finding_ids).toEqual([]);
      expect(check?.metadata.invalid_findings).toBe(3);

      expect(invalidRun.result.contract_failures).toEqual({ functional: 3 });
      expect(invalidRun.result.contract_failure_streaks).toEqual({ functional: 3 });
      expect(invalidRun.result.degraded_personas).toEqual(["functional"]);

      const records = invalidRun.result.invalid_findings;
      expect(records.map((record) => record.persona)).toEqual([
        "functional",
        "functional",
        "functional",
      ]);
      expect(records.map((record) => record.check_id)).toEqual([
        "contract.probe",
        "contract.probe",
        "contract.probe",
      ]);
      expect(records.every((record) => record.contract === "persona_output_schema")).toBe(true);
      expect(records[0]?.errors.some((error) => error.includes("not one of"))).toBe(true);
      expect(records[1]?.errors.some((error) => error.includes("expected type array"))).toBe(true);
      expect(
        records[2]?.errors.some((error) => error.includes("missing required property 'verification'")),
      ).toBe(true);

      expect(invalidRun.result.confidence.score).toBeGreaterThan(0);
      expect(invalidRun.logs.join("\n")).toContain("quarantined invalid finding");

      const { report } = invalidRun;
      expect(report.findings).toEqual([]);
      expect(report.invalid_findings).toHaveLength(3);
      expect(report.contract_failures).toEqual({
        total: 3,
        by_persona: { functional: 3 },
        degraded_personas: ["functional"],
      });
      const functional = (report.personas as Array<Record<string, unknown>>).find(
        (persona) => persona.id === "functional",
      );
      expect(functional?.contract_failures).toBe(3);
      expect(functional?.contract_failure_streak).toBe(3);
      expect(functional?.degraded).toBe(true);
      const limitations = report.limitations as string[];
      expect(limitations).toContain(
        "3 finding(s) violated a persona output contract and were quarantined; they are excluded from scoring and kill-switch evaluation.",
      );
      expect(limitations).toContain(
        "Persona 'functional' produced three consecutive schema-invalid findings and is marked degraded.",
      );

      const progressText = await readFile(invalidRun.store.progressPath, "utf8");
      const reportText = JSON.stringify(report);
      for (const persisted of [progressText, reportText]) {
        expect(persisted).not.toContain(SENSITIVE_VALUE);
        expect(persisted).toContain("[REDACTED]");
      }
      const persisted = JSON.parse(progressText) as Record<string, unknown>;
      expect(persisted.findings).toEqual([]);
      expect(persisted.invalid_findings).toHaveLength(3);
      expect(persisted.contract_failures).toEqual({ functional: 3 });
      expect(persisted.degraded_personas).toEqual(["functional"]);

      const control = await runScenario(path.join(dir, "control"), [], { killOnCritical: true });
      expect(control.result.invalid_findings).toEqual([]);
      expect(control.result.degraded_personas).toEqual([]);
      expect(control.result.findings).toEqual([]);
      expect(control.result.confidence.score).toBe(invalidRun.result.confidence.score);
    });
  });

  it("resets the consecutive streak on a valid finding while keeping the failure total", async () => {
    await withTempDir(async (dir) => {
      const run = await runScenario(dir, [
        validDraft({ severity: "blocker" }),
        validDraft({ severity: "low" }),
        validDraft({ tags: { tag: "login" } }),
      ]);

      expect(run.result.status).toBe(RunStatus.COMPLETED);
      expect(run.result.findings).toHaveLength(1);
      expect(run.result.invalid_findings).toHaveLength(2);
      expect(run.result.contract_failures).toEqual({ functional: 2 });
      expect(run.result.contract_failure_streaks).toEqual({ functional: 1 });
      expect(run.result.degraded_personas).toEqual([]);
      expect(run.result.checks[0]?.finding_ids).toHaveLength(1);
      expect(run.result.checks[0]?.metadata.invalid_findings).toBe(2);

      const functional = (run.report.personas as Array<Record<string, unknown>>).find(
        (persona) => persona.id === "functional",
      );
      expect(functional?.contract_failures).toBe(2);
      expect(functional?.contract_failure_streak).toBe(1);
      expect(functional?.degraded).toBe(false);
    });
  });

  it("de-duplicates valid findings by fingerprint and merges evidence", () => {
    withFrozenDeterminism(() => {
      const state = createRunState({ target: TARGET, intent: "dedupe" });
      const check = baseCheck({ id: "contract.dedupe", persona: "functional" });
      const persona = {
        id: "functional",
        output_schema: {
          type: "object",
          required: ["verification"],
          properties: { verification: { type: "string" } },
        },
      };

      const first = recordCheckFindings(
        state,
        check,
        [validDraft({ evidence: ["evidence/first.txt"] })],
        persona,
      );
      const second = recordCheckFindings(
        state,
        check,
        [validDraft({ evidence: ["evidence/second.txt"] })],
        persona,
      );

      expect(state.findings).toHaveLength(1);
      expect(first.findings).toHaveLength(1);
      expect(second.findings).toHaveLength(1);
      expect(second.findings[0]?.id).toBe(first.findings[0]?.id);
      expect(check.finding_ids).toEqual([first.findings[0]?.id]);
      expect(state.findings[0]?.evidence).toEqual([
        "evidence/first.txt",
        "evidence/second.txt",
      ]);
      expect(state.findings[0]?.fingerprint).toBe(
        findingFingerprint(
          "functional",
          "Login button is unreachable",
          "src/login.ts:42",
          "high",
        ),
      );
      expect(state.findings[0]?.fingerprint).toHaveLength(16);
    });
  });

  it("extracts raw draft payloads without inventing fields or throwing", () => {
    expect(draftPayload({ title: "x" })).toEqual({ title: "x" });
    expect(draftPayload({ title: "x", verification: undefined })).toEqual({
      title: "x",
      verification: undefined,
    });
    expect(draftPayload("raw")).toEqual({ value: "raw" });
    expect(draftPayload([1, 2])).toEqual({ value: [1, 2] });
    expect(draftPayload(new Map([["title", "mapped"]]))).toEqual({ title: "mapped" });
    expect(draftPayload({ to_dict: () => ({ title: "from-dict" }) })).toEqual({
      title: "from-dict",
    });

    const throwing: Record<string, unknown> = { title: "x" };
    Object.defineProperty(throwing, "verification", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(draftPayload(throwing)).toEqual({ title: "x" });
  });

  it("redacts quarantined errors and payloads before persistence", () => {
    withFrozenDeterminism(() => {
      const state = createRunState({ target: TARGET, intent: "redact" });
      const result = quarantineFinding(
        state,
        { id: "contract.probe", persona: "functional" },
        { consequence: `token=${SENSITIVE_VALUE}`, api_key: "synthetic-key" },
        [`Authorization: Bearer ${SENSITIVE_VALUE}`],
        { now: () => FROZEN, nextId: () => "invalid-finding-fixed" },
      );

      expect(result.record.id).toBe("invalid-finding-fixed");
      expect(result.record.recorded_at).toBe(FROZEN);
      expect(result.record.errors.join(" ")).not.toContain(SENSITIVE_VALUE);
      expect(result.record.errors.join(" ")).toContain("[REDACTED]");
      expect(JSON.stringify(result.record.payload)).not.toContain(SENSITIVE_VALUE);
      expect(JSON.stringify(result.record.payload)).not.toContain("synthetic-key");
      expect(JSON.stringify(result.record.payload)).toContain("[REDACTED]");
      expect(result.streak).toBe(1);
      expect(result.degraded).toBe(false);
    });
  });

  it("rebuilds contract health after resume prunes invalid records", () => {
    withFrozenDeterminism(() => {
      const state = createRunState({ target: TARGET, intent: "rebuild" });
      const check = { id: "contract.probe", persona: "functional" };
      for (let index = 0; index < 3; index += 1) {
        quarantineFinding(state, check, { index }, ["invalid"]);
      }
      rebuildContractHealth(state);
      expect(state.contract_failures).toEqual({ functional: 3 });
      expect(state.contract_failure_streaks).toEqual({ functional: 3 });
      expect(state.degraded_personas).toEqual(["functional"]);

      state.invalid_findings = state.invalid_findings.slice(1);
      rebuildContractHealth(state);
      expect(state.contract_failures).toEqual({ functional: 2 });
      expect(state.contract_failure_streaks).toEqual({ functional: 2 });
      expect(state.degraded_personas).toEqual([]);

      state.invalid_findings = [];
      rebuildContractHealth(state);
      expect(state.contract_failures).toEqual({});
      expect(state.contract_failure_streaks).toEqual({});
      expect(state.degraded_personas).toEqual([]);
    });
  });

  it("skips validation when no persona contract is supplied, matching assay", () => {
    withFrozenDeterminism(() => {
      const state = createRunState({ target: TARGET, intent: "no-contract" });
      const check = baseCheck({ id: "contract.unknown", persona: "functional" });
      const result = recordCheckFindings(state, check, [validDraft({ severity: "blocker" })], null);

      expect(result.invalidCount).toBe(0);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.severity).toBe("blocker");
      expect(state.invalid_findings).toEqual([]);
      expect(state.contract_failures).toEqual({});
    });
  });
});
