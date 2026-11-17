import { StateError } from "@lemma/core";

import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "./entitlement.js";

export const BENCHMARK_SCHEMA_VERSION = "lemma.pro.benchmark/v1" as const;
export const BENCHMARK_VERSION = "1.0.0" as const;
export const MIN_BENCHMARK_SAMPLE_SIZE = 5;

export class ConsentRequiredError extends Error {
  readonly code = "consent_required" as const;

  constructor(message = "Explicit consent is required to compute benchmarks.") {
    super(message);
    this.name = "ConsentRequiredError";
  }
}

export interface BenchmarkAggregate {
  benchmark_version?: string;
  category: string;
  sample_size?: number;
  mean_score?: number | null;
  p50_score?: number | null;
  p90_score?: number | null;
  last_updated_at?: string | null;
  source?: { type?: string; id?: string; documented?: boolean; [key: string]: unknown } | string;
  metrics?: Record<string, unknown>;
  // documented aggregates only; no per-tenant rows
  [key: string]: unknown;
}

export interface ComputeBenchmarkParams {
  target: Record<string, any>;
  category: string;
  consent: boolean;
  aggregates?: BenchmarkAggregate | null;
  aggregateCatalog?: Record<string, BenchmarkAggregate> | null;
  license?: ProLicenseContext | null;
  minSampleSize?: number;
}

export interface BenchmarkResult {
  schema_version: typeof BENCHMARK_SCHEMA_VERSION;
  benchmark_version: string;
  target: Record<string, any>;
  category: string;
  consent: true;
  status: "ok" | "insufficient_sample";
  sample_size: number | null;
  last_updated_at: string | null;
  aggregate_source: { type: string; documented: true; id?: string; [key: string]: unknown };
  comparison: Record<string, any> | null;
  reason?: string;
  [key: string]: unknown;
}

function assertLicensed(license: ProLicenseContext | null | undefined): void {
  if (!isProLicensed(license ?? null)) throw new ProUnavailableError("category benchmarks");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function rankTarget(targetScore: number, agg: BenchmarkAggregate): Record<string, any> {
  const mean = asNumber(agg.mean_score);
  const p50 = asNumber(agg.p50_score);
  const p90 = asNumber(agg.p90_score);
  let percentileBand = "unknown";
  if (p90 != null && targetScore >= p90) percentileBand = ">=p90";
  else if (p50 != null && targetScore >= p50) percentileBand = "p50-p90";
  else if (p50 != null) percentileBand = "<p50";
  const deltaVsMean = mean == null ? null : Math.round((targetScore - mean) * 100) / 100;
  const deltaVsP50 = p50 == null ? null : Math.round((targetScore - p50) * 100) / 100;
  return {
    target_score: targetScore,
    percentile_band: percentileBand,
    delta_vs_mean: deltaVsMean,
    delta_vs_p50: deltaVsP50,
    aggregate: {
      mean_score: mean,
      p50_score: p50,
      p90_score: p90,
      metrics: isRecord(agg.metrics) ? agg.metrics : undefined,
    },
  };
}

export function validateBenchmark(result: any): string[] {
  const errors: string[] = [];
  if (!isRecord(result)) return ["benchmark must be an object"];
  if (result.schema_version !== BENCHMARK_SCHEMA_VERSION) errors.push("schema_version");
  if (typeof result.benchmark_version !== "string" || !result.benchmark_version) errors.push("benchmark_version");
  if (!isRecord(result.target)) errors.push("target");
  if (typeof result.category !== "string" || !result.category) errors.push("category");
  if (result.consent !== true) errors.push("consent");
  if (result.status !== "ok" && result.status !== "insufficient_sample") errors.push("status");
  if (!(result.sample_size === null || (typeof result.sample_size === "number" && Number.isInteger(result.sample_size) && result.sample_size >= 0))) errors.push("sample_size");
  if (!(result.last_updated_at === null || typeof result.last_updated_at === "string")) errors.push("last_updated_at");
  if (!isRecord(result.aggregate_source) || result.aggregate_source.documented !== true || typeof result.aggregate_source.type !== "string") errors.push("aggregate_source");
  if (!(result.comparison === null || isRecord(result.comparison))) errors.push("comparison");
  if (result.status === "insufficient_sample" && result.comparison !== null) errors.push("insufficient_sample_must_not_extrapolate");
  return errors;
}

export function computeBenchmark(params: ComputeBenchmarkParams): BenchmarkResult {
  assertLicensed(params.license);
  if (params.consent !== true) {
    throw new ConsentRequiredError("Explicit opt-in consent is required before benchmarking a target.");
  }

  const target = isRecord(params.target) ? params.target : {};
  const category = String(params.category || "").trim();
  if (!category) throw new StateError("benchmark category is required", { details: { field: "category" } });

  const agg = params.aggregates
    ?? (params.aggregateCatalog && category ? params.aggregateCatalog[category] : null)
    ?? null;

  const aggSourceRaw = agg && isRecord(agg.source) ? agg.source : (typeof agg?.source === "string" ? { type: agg.source } : null);
  const aggregate_source = {
    type: String(aggSourceRaw?.type || (agg ? "documented_aggregate" : "none")),
    documented: true as const,
    ...(aggSourceRaw?.id || (agg as any)?.id ? { id: String(aggSourceRaw?.id || (agg as any)?.id) } : {}),
  };

  const sampleSize = agg ? (asNumber(agg.sample_size) == null ? null : Math.max(0, Math.floor(asNumber(agg.sample_size)!))) : null;
  const lastUpdated = agg ? (typeof agg.last_updated_at === "string" ? agg.last_updated_at : (agg.last_updated_at == null ? null : String(agg.last_updated_at))) : null;
  const benchmarkVersion = String(agg?.benchmark_version || BENCHMARK_VERSION);
  const minSample = Math.max(1, Math.floor(params.minSampleSize ?? MIN_BENCHMARK_SAMPLE_SIZE));

  const hasAggregate = !!agg && isRecord(agg);
  const aggregateUsable = hasAggregate && (agg as BenchmarkAggregate).category ? String((agg as BenchmarkAggregate).category) === category || true : hasAggregate;
  const insufficient = !aggregateUsable || sampleSize == null || sampleSize < minSample || (asNumber(agg?.mean_score) == null && asNumber(agg?.p50_score) == null && asNumber(agg?.p90_score) == null);

  let status: "ok" | "insufficient_sample" = insufficient ? "insufficient_sample" : "ok";
  let comparison: Record<string, any> | null = null;
  let reason: string | undefined;

  if (status === "insufficient_sample") {
    comparison = null; // never extrapolated
    reason = !hasAggregate ? "missing documented aggregate for category" : "insufficient_sample";
  } else {
    const targetScoreRaw = asNumber((target as any).score ?? (target as any).health_score ?? (target as any).value);
    // if target score missing we still report comparison against documented aggregate but mark ranking unavailable (no extrapolation)
    if (targetScoreRaw == null) {
      status = "insufficient_sample";
      comparison = null;
      reason = "insufficient_sample";
    } else {
      comparison = rankTarget(clampPct(targetScoreRaw), agg as BenchmarkAggregate);
      comparison.benchmark = {
        benchmark_version: benchmarkVersion,
        category,
        sample_size: sampleSize,
        last_updated_at: lastUpdated,
      };
    }
  }

  const result: BenchmarkResult = {
    schema_version: BENCHMARK_SCHEMA_VERSION,
    benchmark_version: benchmarkVersion,
    target: { ...target },
    category,
    consent: true,
    status,
    sample_size: sampleSize,
    last_updated_at: lastUpdated,
    aggregate_source,
    comparison,
    ...(reason ? { reason } : {}),
  };

  const errors = validateBenchmark(result);
  if (errors.length) {
    throw new StateError(`Benchmark failed schema validation: ${errors.join(", ")}`, { details: { errors } });
  }
  return result;
}
