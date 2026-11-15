import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckOutcome,
  CheckStatus,
  EvidenceStore,
  PluginCheckRunner,
  Severity,
  Strength,
  blockedPluginOutcome,
  normalizeCheck,
  normalizeTarget,
  type BlockerDraft,
  type Check,
  type FindingDraft,
  type PluginContext,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-plugin-ctx-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeCheck(overrides: Partial<Check> = {}): Check {
  return normalizeCheck({
    id: "example.plugin_check",
    title: "Example plugin check",
    domain: "functional",
    persona: "functional",
    kind: "plugin",
    intent: "Exercise plugin execution.",
    expected: "Plugin returns a valid outcome.",
    base_weight: 1,
    weight: 1,
    status: CheckStatus.PLANNED,
    actual: "",
    evidence: [],
    finding_ids: [],
    skip_reason: "",
    started_at: null,
    completed_at: null,
    metadata: {},
    ...overrides,
  });
}

describe("LEM-076 plugin context and blocked-failure handling", () => {
  it("provides bounded context and saveJson persists run-relative evidence under the check", async () => {
    await withTempDir(async (root) => {
      const target = normalizeTarget({ raw: ".", kind: "directory", resolved: root });
      const evidence = new EvidenceStore(root, "run_plugin_ctx");
      await evidence.init();
      const runner = new PluginCheckRunner(target, root, { available: true, root }, evidence);
      const check = makeCheck();

      const outcome = await runner.run(check, async (ctx: PluginContext) => {
        expect(ctx.check.id).toBe(check.id);
        expect(ctx.target).toBe(target);
        expect(ctx.root).toBe(root);
        expect(ctx.evidence).toBe(evidence);
        expect(typeof ctx.log).toBe("function");
        const ref = await ctx.saveJson("plugin-artifact", { ok: true }, "plugin evidence", "plugin");
        expect(typeof ref).toBe("string");
        expect(ref).toContain("evidence");
        expect(ref).not.toMatch(/^\//);
        return new CheckOutcome({
          status: CheckStatus.PASSED,
          actual: "ok",
          evidence: [ref],
        });
      });

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.evidence).toHaveLength(1);
    });
  });

  it("converts evaluator crashes to ERROR outcomes without throwing", async () => {
    await withTempDir(async (root) => {
      const target = normalizeTarget({ raw: ".", kind: "directory", resolved: root });
      const evidence = new EvidenceStore(root, "run_plugin_crash");
      await evidence.init();
      const runner = new PluginCheckRunner(target, root, {}, evidence);
      const outcome = await runner.run(makeCheck(), () => {
        throw new Error("synthetic plugin crash");
      });
      expect(outcome.status).toBe(CheckStatus.ERROR);
      expect(outcome.actual).toContain("Plugin check crashed");
      expect(outcome.actual).toContain("synthetic plugin crash");
    });
  });

  it("rejects invalid returns, statuses, draft types, and unsafe/missing evidence", async () => {
    await withTempDir(async (root) => {
      const target = normalizeTarget({ raw: ".", kind: "directory", resolved: root });
      const evidence = new EvidenceStore(root, "run_plugin_invalid");
      await evidence.init();
      const runner = new PluginCheckRunner(target, root, {}, evidence);

      const badEvaluator: Parameters<PluginCheckRunner["run"]>[1] = (() => "not-an-outcome") as never;
      let out = await runner.run(makeCheck(), badEvaluator);
      expect(out.status).toBe(CheckStatus.ERROR);
      expect(out.actual).toContain("did not return a CheckOutcome");

      out = await runner.run(makeCheck(), () => new CheckOutcome({ status: "bogus" as unknown as CheckStatus }));
      expect(out.status).toBe(CheckStatus.ERROR);
      expect(out.actual).toContain("unknown check status");

      out = await runner.run(makeCheck(), () => new CheckOutcome({ status: CheckStatus.FAILED, findings: [{} as FindingDraft] }));
      expect(out.status).toBe(CheckStatus.ERROR);
      expect(out.actual).toContain("findings must be FindingDraft");

      out = await runner.run(makeCheck(), () => new CheckOutcome({ status: CheckStatus.BLOCKED, blocker: {} as BlockerDraft }));
      expect(out.status).toBe(CheckStatus.ERROR);
      expect(out.actual).toContain("blocker must be a BlockerDraft");

      out = await runner.run(makeCheck(), () => new CheckOutcome({ status: CheckStatus.PASSED, evidence: ["../outside.json"] }));
      expect(out.status).toBe(CheckStatus.ERROR);
      expect(out.actual).toContain("evidence outside this run's evidence directory");

      out = await runner.run(makeCheck(), () => new CheckOutcome({ status: CheckStatus.PASSED, evidence: [path.join(evidence.runDir, "missing.json")] }));
      expect(out.status).toBe(CheckStatus.ERROR);
      expect(out.actual).toContain("evidence outside this run's evidence directory");
    });
  });

  it("enforces finding-evidence linkage rules", async () => {
    await withTempDir(async (root) => {
      const target = normalizeTarget({ raw: ".", kind: "directory", resolved: root });
      const evidence = new EvidenceStore(root, "run_plugin_findings");
      await evidence.init();
      const runner = new PluginCheckRunner(target, root, {}, evidence);
      const ref = await evidence.saveJson("ok", { ok: true }, "plugin", "desc", "example.plugin_check");

      const badFinding: FindingDraft = {
        title: "bad",
        severity: Severity.MEDIUM,
        domain: "functional",
        strength: Strength.SOURCE_PROVEN,
        consequence: "c",
        location: "",
        reproduction: "",
        evidence: [path.join(evidence.runDir, "missing.json")],
        remediation: "",
        verification: "",
        tags: [],
      };
      let out = await runner.run(makeCheck(), () => new CheckOutcome({ status: CheckStatus.FAILED, evidence: [ref], findings: [badFinding] }));
      expect(out.status).toBe(CheckStatus.ERROR);
      expect(out.actual).toContain("finding evidence must be included in the check evidence");

      const noEvidenceFinding: FindingDraft = { ...badFinding, evidence: [] };
      out = await runner.run(makeCheck(), () => new CheckOutcome({ status: CheckStatus.FAILED, evidence: [], findings: [noEvidenceFinding] }));
      expect(out.status).toBe(CheckStatus.ERROR);
      expect(out.actual).toContain("findings require evidence");

      const goodFinding: FindingDraft = { ...badFinding, evidence: [ref] };
      out = await runner.run(makeCheck(), () => new CheckOutcome({ status: CheckStatus.FAILED, evidence: [ref], findings: [goodFinding] }));
      expect(out.status).toBe(CheckStatus.FAILED);
      expect(out.findings).toHaveLength(1);
    });
  });

  it("produces blocked plugin outcomes for blocked-failure handling (coverage gap)", async () => {
    await withTempDir(() => {
      const check = makeCheck({ id: "plugin.load.broken", title: "Plugin 'broken' could not be loaded" });
      const out = blockedPluginOutcome(check, "Plugin 'broken' could not be imported: Error: synthetic missing dependency");
      expect(out.status).toBe(CheckStatus.BLOCKED);
      expect(out.actual).toContain("could not be imported");
      expect(out.blocker).toBeTruthy();
      expect(out.blocker?.boundary).toContain("could not be imported");
      expect(out.blocker?.attempted_action.length ?? 0).toBeGreaterThan(0);
      expect(out.blocker?.unblock_evidence.length ?? 0).toBeGreaterThan(0);
      expect(out.findings).toHaveLength(0);
      return Promise.resolve();
    });
  });
});
