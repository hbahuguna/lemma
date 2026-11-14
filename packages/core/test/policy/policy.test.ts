import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  PolicyError,
  Severity,
  Strength,
  loadPolicy,
  normalizeCheck,
  normalizeFinding,
  policyFromDict,
  scoreConfidence,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-policy-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function check(status = CheckStatus.PASSED) {
  return normalizeCheck({
    id: "a",
    title: "a",
    domain: "functional",
    persona: "functional",
    kind: "static",
    intent: "test",
    expected: "test",
    base_weight: 1.0,
    weight: 1.0,
    status,
  });
}

describe("LEM-019 versioned policy files and gate evaluation", () => {
  it("loads default advisory-v1 policy file and reproduces advisory scoring behavior", async () => {
    const policyPath = path.resolve(process.cwd(), "../../policies/advisory-v1.json");
    const raw = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
    expect(raw.schema_version).toBe("quality-harness.policy/v1");
    expect(raw.id).toBe("advisory-v1");
    expect(raw.version).toBe("1.0");

    const policy = await loadPolicy(policyPath);
    expect(policy.id).toBe("advisory-v1");
    expect(policy.version).toBe("1.0");
    const confidence = scoreConfidence([check()], [], { policy });
    expect(confidence.score).toBe(90.0);
    expect((confidence.gate as { policy: string }).policy).toBe("advisory-v1");
    expect((confidence.breakdown as { policy_id: string }).policy_id).toBe("advisory-v1");
    expect((confidence.breakdown as { policy_version: string }).policy_version).toBe("1.0");
  });

  it("accepts partial/relaxed versioned policies with defaults", async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, "policy.json");
      await writeFile(
        p,
        JSON.stringify(
          {
            schema_version: "quality-harness.policy/v1",
            id: "relaxed",
            version: "2.0",
            gate: {
              pass_score: 80.0,
              warn_score: 20.0,
              fail_on_critical: true,
              fail_on_high: false,
              coverage_warn: 0.8,
              coverage_fail: 0.7,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const policy = await loadPolicy(p);
      expect(policy.id).toBe("relaxed");
      expect(policy.version).toBe("2.0");
      expect(policy.penalty_cap).toBe(70);
      expect(policy.domain_weights.security).toBe(1.5);
      const c = scoreConfidence([check()], [], { policy });
      expect(c.score).toBe(90);
      expect(c.gate.status).toBe("pass");
    });
  });

  it("rejects invalid policies (unknown fields, invalid values, unsafe ordering)", async () => {
    await withTempDir(async (dir) => {
      const write = async (name: string, obj: unknown) => {
        const p = path.join(dir, name);
        await writeFile(p, JSON.stringify(obj), "utf8");
        return p;
      };

      const emptyWeights = await write("empty.json", { id: "bad", version: "1", domain_weights: {} });
      await expect(loadPolicy(emptyWeights)).rejects.toBeInstanceOf(PolicyError);

      const unsafeCaps = await write("unsafe.json", {
        schema_version: "quality-harness.policy/v1",
        id: "unsafe",
        version: "1",
        caps: { critical: 50.0, two_high: 40.0, halted: 25.0 },
      });
      await expect(loadPolicy(unsafeCaps)).rejects.toThrow(/critical cap/);

      const unknown = await write("unknown.json", {
        schema_version: "quality-harness.policy/v1",
        id: "bad",
        version: "1",
        unknown_field: true,
      });
      await expect(loadPolicy(unknown)).rejects.toThrow(/Unknown policy field/);

      expect(() => policyFromDict({ schema_version: "nope" })).toThrow(PolicyError);
    });
  });

  it("evaluates gates per loaded custom policy (thresholds and critical/high settings)", () => {
    const baseChecks = [check()];
    const highFinding = normalizeFinding({
      id: "f1",
      title: "high",
      severity: Severity.HIGH,
      domain: "functional",
      persona: "functional",
      strength: Strength.SOURCE_PROVEN,
      consequence: "c",
      check_id: "a",
      fingerprint: "h1",
    });
    const strictFailHigh = policyFromDict({
      schema_version: "quality-harness.policy/v1",
      id: "strict",
      version: "1",
      gate: {
        pass_score: 80,
        warn_score: 60,
        fail_on_critical: true,
        fail_on_high: true,
        coverage_warn: 0.8,
        coverage_fail: 0.7,
      },
    });
    const cFail = scoreConfidence(baseChecks, [highFinding], { policy: strictFailHigh });
    expect(cFail.gate.status).toBe("fail");
    expect((cFail.gate.reasons as string[]).some((r) => r.includes("high-severity"))).toBe(true);

    const relaxedWarn = policyFromDict({
      schema_version: "quality-harness.policy/v1",
      id: "relaxed-warn",
      version: "1",
      gate: {
        pass_score: 95,
        warn_score: 20,
        fail_on_critical: true,
        fail_on_high: false,
        coverage_warn: 0.8,
        coverage_fail: 0.7,
      },
    });
    const cWarn = scoreConfidence(baseChecks, [highFinding], { policy: relaxedWarn });
    expect(cWarn.gate.status).toBe("warn");
    expect((cWarn.breakdown as { policy_id: string }).policy_id).toBe("relaxed-warn");
  });
});
