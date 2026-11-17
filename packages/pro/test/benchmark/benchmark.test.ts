import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConsentRequiredError, ProUnavailableError, computeBenchmark, validateBenchmark } from "../../src/index.js";

const licensed = { verification: true };

function loadSchema() {
  return JSON.parse(require("node:fs").readFileSync(path.resolve(process.cwd(), "../../schemas/pro/benchmark.v1.json"), "utf8"));
}

describe("LEM-202 category benchmarks", () => {
  it("license gate: unlicensed returns ProUnavailableError", () => {
    expect(() => computeBenchmark({ target: { id: "t1", score: 70 }, category: "saas", consent: true, license: null })).toThrow(ProUnavailableError);
  });

  it("consent gate: missing/false consent raises typed ConsentRequiredError", () => {
    expect(() => computeBenchmark({ target: { id: "t1", score: 70 }, category: "saas", consent: false, license: licensed })).toThrow(ConsentRequiredError);
    try {
      computeBenchmark({ target: { id: "t1" }, category: "saas", consent: false as any, license: licensed });
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e).toBeInstanceOf(ConsentRequiredError);
      expect(e.name).toBe("ConsentRequiredError");
      expect(e.code).toBe("consent_required");
    }
  });

  it("computes benchmark from documented aggregates only, cites version/sample/last-updated, and validates schema", () => {
    const aggregate = {
      benchmark_version: "1.0.0",
      category: "saas",
      sample_size: 42,
      mean_score: 60,
      p50_score: 62,
      p90_score: 85,
      last_updated_at: "2026-11-01T00:00:00Z",
      source: { type: "consented_aggregate", id: "agg-saas-2026q4", documented: true },
      metrics: { conversion_rate: 0.12 },
    };
    const result = computeBenchmark({
      target: { id: "target-1", score: 75, tenant_id: "secret-tenant" },
      category: "saas",
      consent: true,
      aggregates: aggregate,
      license: licensed,
    });

    expect(result.schema_version).toBe("lemma.pro.benchmark/v1");
    expect(result.benchmark_version).toBe("1.0.0");
    expect(result.sample_size).toBe(42);
    expect(result.last_updated_at).toBe("2026-11-01T00:00:00Z");
    expect(result.aggregate_source.documented).toBe(true);
    expect(result.aggregate_source.type).toBe("consented_aggregate");
    expect(result.aggregate_source.id).toBe("agg-saas-2026q4");
    expect(result.status).toBe("ok");
    expect(result.comparison?.percentile_band).toBe("p50-p90");

    // no per-tenant data included from aggregates; output should not echo aggregate internals as tenant rows
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("per_tenant");
    expect(serialized).not.toContain("tenant_rows");

    expect(validateBenchmark(result)).toEqual([]);
    const schema = loadSchema();
    expect(schema.properties.consent.const).toBe(true);
    expect(schema.description).toContain("No per-tenant data is included");
  });

  it("reports insufficient_sample with no extrapolation when data missing/insufficient", () => {
    const missing = computeBenchmark({ target: { id: "t1", score: 90 }, category: "fintech", consent: true, aggregates: null, license: licensed });
    expect(missing.status).toBe("insufficient_sample");
    expect(missing.comparison).toBeNull();
    expect(missing.reason).toBeTruthy();

    const small = computeBenchmark({
      target: { id: "t2", score: 90 },
      category: "fintech",
      consent: true,
      aggregates: { category: "fintech", sample_size: 2, mean_score: 50, p50_score: 50, p90_score: 80, last_updated_at: "2026-11-01T00:00:00Z" },
      license: licensed,
      minSampleSize: 5,
    });
    expect(small.status).toBe("insufficient_sample");
    expect(small.comparison).toBeNull(); // never extrapolated
  });
});
