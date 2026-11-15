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
  blockerForCheck,
  blockerPayload,
  buildReport,
  createRunState,
  loadPersonas,
  normalizeTarget,
  recordBlockedCheck,
  recordCheckOutcome,
  scoreConfidence,
  unblockHints,
  type BlockerDraft,
  type Check,
  type Persona,
} from "../../src/index.js";

const PERSONAS_DIR = fileURLToPath(new URL("../../../personas", import.meta.url));
const TARGET = normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" });
const FROZEN = "2026-11-15T00:00:00Z";
const SEEDED = { seed: 4242, clockMode: "frozen" as const, frozenClock: FROZEN };
const SENSITIVE_VALUE = "not-a-real-token-value";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-blockers-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
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
    expected: overrides.expected ?? overrides.title ?? "expected",
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

describe("LEM-046 structured blocker and refusal records", () => {
  it("records one structured blocker for a blocked outcome and discards findings", async () => {
    await withTempDir(async (dir) => {
      const personas = await loadPersonas(PERSONAS_DIR);
      const functional = personas.find((persona) => persona.id === "functional");
      const store = new StateStore(dir);
      const logs: string[] = [];
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: () => {},
          test_planning: (ctx) => {
            ctx.state.personas = personas.map(publicPersona);
            ctx.state.checks = [
              baseCheck({ id: "example.package_metadata", persona: "functional", domain: "data_integrity" }),
            ];
          },
          execution: async (ctx) => {
            const check = ctx.state.checks[0];
            if (!check) throw new Error("missing check");
            const blocker: BlockerDraft = {
              attempted_action: "Submit a synthetic checkout transaction.",
              boundary: "The run is read-only and has no synthetic tenant.",
              unblock_evidence: [
                "Provide a disposable checkout tenant and an approved transaction budget.",
              ],
              covered_elsewhere: false,
              covered_by: [],
            };
            recordCheckOutcome(
              ctx.state,
              check,
              {
                status: CheckStatus.BLOCKED,
                actual: "Refused to submit a synthetic transaction.",
                evidence: ["evidence/blocked.json"],
                findings: [
                  {
                    title: "This finding must be discarded",
                    severity: "high",
                    domain: "data_integrity",
                    strength: "observed",
                    consequence: "A blocked check cannot carry a finding.",
                    location: "",
                    reproduction: "",
                    evidence: [],
                    remediation: "",
                    verification: "",
                    tags: [],
                  },
                ],
                blocker,
                metadata: { limitation: "Read-only run." },
              },
              functional,
              { log: (message) => logs.push(message) },
            );
            await ctx.appendEvent({ event: "check_completed", check_id: check.id, status: check.status });
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
        intent: "verify blocker",
        workflow: RELEASE_CONFIDENCE,
        maxChecks: 1,
        ...SEEDED,
      });

      expect(result.status).toBe(RunStatus.COMPLETED);
      const check = result.checks[0];
      expect(check?.status).toBe(CheckStatus.BLOCKED);
      expect(check?.finding_ids).toEqual([]);
      expect(check?.evidence).toEqual(["evidence/blocked.json"]);
      expect(result.findings).toEqual([]);

      const blockers = result.blockers.filter((b) => b.check_id === "example.package_metadata");
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toMatchObject({
        persona: "functional",
        check_id: "example.package_metadata",
        attempted_action: "Submit a synthetic checkout transaction.",
        boundary: "The run is read-only and has no synthetic tenant.",
        covered_elsewhere: false,
        covered_by: [],
      });
      expect(blockers[0]?.unblock_evidence).toEqual([
        "Provide a disposable checkout tenant and an approved transaction budget.",
      ]);
      expect(logs.join("\n")).toContain("discarded because a blocker cannot carry findings");

      const report = buildReport(result, RELEASE_CONFIDENCE, {}, FROZEN);
      expect(report.blockers).toHaveLength(1);
      expect((report.blockers as Array<Record<string, unknown>>)[0]?.check_id).toBe(
        "example.package_metadata",
      );
      expect(report.coverage).toMatchObject({
        blocked: 1,
        blockers: 1,
        blockers_uncovered: 1,
      });
      expect(
        (report.coverage as { blockers_by_persona?: Record<string, number> }).blockers_by_persona,
      ).toMatchObject({ functional: 1 });
      const byDomain = (report.coverage as { by_domain: Record<string, Record<string, unknown>> }).by_domain;
      expect(byDomain.data_integrity?.blockers).toBe(1);
    });
  });

  it("forces a passed outcome with a blocker to blocked and records one blocker", async () => {
    await withTempDir(async (dir) => {
      const personas = await loadPersonas(PERSONAS_DIR);
      const functional = personas.find((persona) => persona.id === "functional");
      const store = new StateStore(dir);
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: () => {},
          test_planning: (ctx) => {
            ctx.state.personas = personas.map(publicPersona);
            ctx.state.checks = [baseCheck({ id: "example.package_metadata", persona: "functional" })];
          },
          execution: (ctx) => {
            const check = ctx.state.checks[0];
            if (!check) throw new Error("missing check");
            recordCheckOutcome(
              ctx.state,
              check,
              {
                status: CheckStatus.PASSED,
                actual: "The plugin incorrectly claimed a pass.",
                blocker: {
                  attempted_action: "Claim the check passed.",
                  boundary: "A refusal cannot be converted into a pass.",
                  unblock_evidence: ["Resolve the blocker before rerunning."],
                  covered_elsewhere: false,
                  covered_by: [],
                },
              },
              functional,
            );
          },
          evidence_collection: () => {},
          confidence_scoring: (ctx) => {
            ctx.state.confidence = scoreConfidence(ctx.state.checks, ctx.state.findings, {});
          },
        },
      });

      const result = await orch.run({
        target: TARGET,
        intent: "force blocked",
        workflow: RELEASE_CONFIDENCE,
        maxChecks: 1,
        ...SEEDED,
      });

      expect(result.checks[0]?.status).toBe(CheckStatus.BLOCKED);
      expect(result.checks[0]?.finding_ids).toEqual([]);
      expect(result.findings).toEqual([]);
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]?.check_id).toBe("example.package_metadata");
    });
  });

  it("derives fallback payloads, unblock hints, and dedupes one blocker per check", () => {
    const state = createRunState({ target: TARGET, intent: "fallback" });
    const check = baseCheck({
      id: "browser.load",
      persona: "functional",
      title: "Load target",
      expected: "Load the target URL",
    });

    expect(unblockHints(check, "no persona owner declared")).toEqual([
      "Declare exactly one persona owner for check 'browser.load' and re-run.",
    ]);
    expect(unblockHints(check, "plugin signature not trusted")).toEqual([
      "Install a signed plugin with trusted metadata for check 'browser.load' and re-run.",
    ]);
    expect(unblockHints(check, "Playwright/Chromium is unavailable")).toEqual([
      "Provide a runnable browser target and a Playwright/Chromium installation, then re-run check 'browser.load'.",
    ]);
    expect(unblockHints(check, "source inventory missing")).toEqual([
      "Provide a readable source directory for check 'browser.load' and re-run.",
    ]);
    expect(unblockHints(check, "unknown boundary")).toEqual([
      "Resolve the reported boundary for check 'browser.load' and re-run it.",
    ]);

    const fallback = blockerPayload(
      check,
      { status: CheckStatus.BLOCKED, actual: "", metadata: { note: "Need a browser install." } },
      null,
      "Browser runtime unavailable",
    );
    expect(fallback.attempted_action).toBe("Load the target URL");
    expect(fallback.boundary).toBe("Browser runtime unavailable");
    expect(fallback.unblock_evidence).toEqual(["Need a browser install."]);

    const persona = {
      id: "functional",
      blocker_schema: {
        type: "object",
        required: [
          "persona",
          "check_id",
          "attempted_action",
          "boundary",
          "unblock_evidence",
          "covered_elsewhere",
        ],
        properties: {
          persona: { type: "string" },
          check_id: { type: "string" },
          attempted_action: { type: "string" },
          boundary: { type: "string" },
          unblock_evidence: { type: "array", items: { type: "string" } },
          covered_elsewhere: { type: "boolean" },
          covered_by: { type: "array", items: { type: "string" } },
        },
      },
    };

    const first = recordBlockedCheck(
      state,
      check,
      {
        status: CheckStatus.BLOCKED,
        actual: "No browser.",
        metadata: { limitation: "declared persona owner missing" },
      },
      persona,
      { now: () => FROZEN, nextId: () => "blocker-fixed" },
    );
    const second = recordBlockedCheck(
      state,
      check,
      { status: CheckStatus.BLOCKED, actual: "Different." },
      persona,
    );

    expect(state.blockers).toHaveLength(1);
    expect(first.id).toBe("blocker-fixed");
    expect(second.id).toBe("blocker-fixed");
    expect(blockerForCheck(state, "browser.load")?.id).toBe("blocker-fixed");
    expect(check.status).toBe(CheckStatus.BLOCKED);
    expect(check.finding_ids).toEqual([]);
  });

  it("redacts blocker text and blocked metadata before persistence", async () => {
    await withTempDir(async (dir) => {
      const personas = await loadPersonas(PERSONAS_DIR);
      const functional = personas.find((persona) => persona.id === "functional");
      const store = new StateStore(dir);
      const orch = new Orchestrator({
        store,
        handlers: {
          risk_analysis: () => {},
          test_planning: (ctx) => {
            ctx.state.personas = personas.map(publicPersona);
            ctx.state.checks = [baseCheck({ id: "secret.check", persona: "functional" })];
          },
          execution: (ctx) => {
            const check = ctx.state.checks[0];
            if (!check) throw new Error("missing check");
            recordCheckOutcome(
              ctx.state,
              check,
              {
                status: CheckStatus.BLOCKED,
                actual: `Refused: token=${SENSITIVE_VALUE}`,
                blocker: {
                  attempted_action: `Read token=${SENSITIVE_VALUE}`,
                  boundary: `Credentials required token=${SENSITIVE_VALUE}`,
                  unblock_evidence: [`Provide token=${SENSITIVE_VALUE}`],
                  covered_elsewhere: false,
                  covered_by: [],
                },
                metadata: { limitation: `token=${SENSITIVE_VALUE}`, note: "safe" },
              },
              functional,
            );
          },
          evidence_collection: () => {},
          confidence_scoring: (ctx) => {
            ctx.state.confidence = scoreConfidence(ctx.state.checks, ctx.state.findings, {});
          },
        },
      });

      const result = await orch.run({
        target: TARGET,
        intent: "redact blocker",
        workflow: RELEASE_CONFIDENCE,
        maxChecks: 1,
        ...SEEDED,
      });

      expect(result.blockers[0]?.boundary).not.toContain(SENSITIVE_VALUE);
      expect(result.blockers[0]?.attempted_action).not.toContain(SENSITIVE_VALUE);
      expect(result.blockers[0]?.unblock_evidence.join(" ")).not.toContain(SENSITIVE_VALUE);
      expect(JSON.stringify(result.blockers[0])).toContain("[REDACTED]");
      expect(result.checks[0]?.actual).not.toContain(SENSITIVE_VALUE);
      expect(JSON.stringify(result.checks[0]?.metadata)).not.toContain(SENSITIVE_VALUE);

      const progressText = await readFile(store.progressPath, "utf8");
      expect(progressText).not.toContain(SENSITIVE_VALUE);
      expect(progressText).toContain("[REDACTED]");
    });
  });

  it("warns on persona blocker-contract violations but still records the blocker", () => {
    const state = createRunState({ target: TARGET, intent: "invalid blocker" });
    const check = baseCheck({ id: "contract.blocker", persona: "functional" });
    const logs: string[] = [];
    const persona = {
      id: "functional",
      blocker_schema: {
        type: "object",
        required: ["extra_required_field"],
        properties: {
          extra_required_field: { type: "string" },
        },
      },
    };

    const blocker = recordBlockedCheck(
      state,
      check,
      { status: CheckStatus.BLOCKED, actual: "blocked", metadata: {} },
      persona,
      { log: (message) => logs.push(message) },
    );

    expect(state.blockers).toHaveLength(1);
    expect(blocker.check_id).toBe("contract.blocker");
    expect(logs.join("\n")).toContain("violates the functional blocker contract");
  });

  it("records non-blocked outcomes through finding validation and quarantine", () => {
    const state = createRunState({ target: TARGET, intent: "non-blocked" });
    const check = baseCheck({ id: "static.tests", persona: "functional" });
    const persona = {
      id: "functional",
      output_schema: {
        type: "object",
        required: [
          "title",
          "severity",
          "domain",
          "strength",
          "consequence",
          "location",
          "reproduction",
          "remediation",
          "verification",
        ],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          domain: { type: "string" },
          strength: { type: "string" },
          consequence: { type: "string" },
          location: { type: "string" },
          reproduction: { type: "string" },
          remediation: { type: "string" },
          verification: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    };

    const result = recordCheckOutcome(
      state,
      check,
      {
        status: CheckStatus.FAILED,
        actual: "found issues",
        findings: [
          {
            title: "Missing test",
            severity: "high",
            domain: "functional",
            strength: "source_proven",
            consequence: "gap",
            location: "tests/",
            reproduction: "run tests",
            remediation: "add tests",
            verification: "tests pass",
            evidence: [],
            tags: [],
          },
          { severity: "blocker" },
        ],
      },
      persona,
    );

    expect(result.blocked).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.invalidCount).toBe(1);
    expect(state.findings).toHaveLength(1);
    expect(state.invalid_findings).toHaveLength(1);
    expect(check.status).toBe(CheckStatus.FAILED);
    expect(check.finding_ids).toHaveLength(1);
    expect(check.metadata.invalid_findings).toBe(1);
  });
});
