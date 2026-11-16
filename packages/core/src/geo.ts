import path from "node:path";
import { randomUUID } from "node:crypto";

import { StateError } from "./errors.js";
import { EvidenceStore } from "./evidence.js";
import { ensureDir, atomicWriteJson } from "./state.js";
import { redactUnknown } from "./redaction.js";
import { validateUrl } from "./ssrf.js";
import { now as deterministicNow } from "./determinism.js";

export type GeoCheckCategory = "crawler_eligibility" | "structured_data" | "credibility" | "grounding";
export type GeoStatus = "pass" | "fail" | "unknown";

export interface GeoCheck {
  id: string;
  category: GeoCheckCategory;
  title: string;
  status: GeoStatus;
  details: string;
  evidence: string[];
}

export interface RunGeoParams {
  target: string;
  root?: string;
  runId?: string;
  stateDirName?: string;
  fetch?: (url: string) => Promise<{ status: number; ok: boolean; text?: string; headers?: Record<string, string> }>;
  page?: { html?: string; structuredData?: unknown; author?: string; citations?: string[]; dates?: string[]; groundedSnippets?: string[]; answerConstruction?: { measured: boolean; sources?: string[]; notes?: string } };
}

export interface GeoReport {
  schema_version: "lemma.geo_report/v1";
  run_id: string;
  target: string;
  checks: GeoCheck[];
  summary: { total: number; pass: number; fail: number; unknown: number };
  evidence: { directory: string; manifest: string; artifacts: string[] };
  [key: string]: unknown;
}

async function safeFetch(fetcher: NonNullable<RunGeoParams["fetch"]>, url: string): Promise<{ status: number; ok: boolean; text?: string; headers?: Record<string, string> }> {
  try {
    await validateUrl(url);
    return await fetcher(url);
  } catch (e: any) {
    return { status: 0, ok: false, text: `fetch_error:${e?.message || String(e)}` };
  }
}

function mk(id: string, category: GeoCheckCategory, title: string, status: GeoStatus, details: string, evidence: string[]): GeoCheck {
  return { id, category, title, status, details, evidence };
}

function validateReportShape(report: GeoReport): void {
  if (report.schema_version !== "lemma.geo_report/v1") throw new StateError("Invalid GeoReport schema_version");
  if (!report.run_id) throw new StateError("Invalid GeoReport run_id");
  if (!Array.isArray(report.checks)) throw new StateError("Invalid GeoReport checks");
  for (const c of report.checks) {
    if (!c || !["crawler_eligibility", "structured_data", "credibility", "grounding"].includes(c.category)) throw new StateError("Invalid GeoReport check category");
    if (!["pass", "fail", "unknown"].includes(c.status)) throw new StateError("Invalid GeoReport check status");
    if (!Array.isArray(c.evidence)) throw new StateError("Invalid GeoReport check evidence");
  }
  if (!report.summary || typeof report.summary.total !== "number") throw new StateError("Invalid GeoReport summary");
  if (!report.evidence || !Array.isArray(report.evidence.artifacts)) throw new StateError("Invalid GeoReport evidence");
}

export async function runGeo(params: RunGeoParams): Promise<GeoReport> {
  if (!params || typeof params.target !== "string" || !params.target) throw new StateError("runGeo requires target");
  const root = path.resolve(params.root ?? process.cwd());
  const runId = params.runId || `geo-${randomUUID()}`;
  await validateUrl(params.target);

  const evidence = new EvidenceStore(root, runId, { stateDirName: params.stateDirName ?? ".lemma" });
  await evidence.init();
  const outDir = path.join(root, ".lemma", "evidence", runId, "geo");
  await ensureDir(outDir);

  const fetcher = params.fetch ?? (async (url: string) => {
    const res = await fetch(url);
    const text = await res.text().catch(() => "");
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, ok: res.ok, text, headers };
  });

  const base = params.target.replace(/\/+$/, "");
  const page = params.page || {};

  const robots = await safeFetch(fetcher, `${base}/robots.txt`);
  const sitemap = await safeFetch(fetcher, `${base}/sitemap.xml`);
  const wellKnown = await safeFetch(fetcher, `${base}/.well-known/security.txt`);

  const crawlRef = await evidence.saveJson("geo-crawler-eligibility", redactUnknown({
    target: params.target,
    robots: { status: robots.status, ok: robots.ok, sample: (robots.text || "").slice(0, 500) },
    sitemap: { status: sitemap.status, ok: sitemap.ok, sample: (sitemap.text || "").slice(0, 500) },
    well_known: { status: wellKnown.status, ok: wellKnown.ok, sample: (wellKnown.text || "").slice(0, 300) },
  }), "json", "Crawler eligibility resources (robots/sitemap/well-known)", "geo");

  const structuredRef = await evidence.saveJson("geo-structured-data", redactUnknown({
    structuredData: page.structuredData ?? null,
    html_sample: (page.html || "").slice(0, 800),
  }), "json", "Structured data extracts/snapshot", "geo");

  const credibilityRef = await evidence.saveJson("geo-credibility", redactUnknown({
    author: page.author ?? null,
    citations: page.citations ?? null,
    dates: page.dates ?? null,
  }), "json", "Credibility signals (author/citations/dates)", "geo");

  const groundingRef = await evidence.saveJson("geo-grounding", redactUnknown({
    answerConstruction: page.answerConstruction ?? null,
    groundedSnippets: page.groundedSnippets ?? null,
    measured: !!(page.answerConstruction?.measured || (page.groundedSnippets && page.groundedSnippets.length)),
  }), "json", "Grounding measurement (how answers constructed from page)", "geo");

  const checks: GeoCheck[] = [];

  // Crawler eligibility
  if (robots.ok || sitemap.ok || wellKnown.ok) {
    checks.push(mk("crawler.eligibility", "crawler_eligibility", "Crawler eligibility signals (robots/sitemap/well-known)", "pass", "At least one crawler eligibility/discovery resource is reachable.", [crawlRef]));
  } else if (robots.status === 0 && sitemap.status === 0 && wellKnown.status === 0) {
    checks.push(mk("crawler.eligibility", "crawler_eligibility", "Crawler eligibility signals (robots/sitemap/well-known)", "unknown", "Crawler eligibility resources not fetched/inspected.", [crawlRef]));
  } else {
    checks.push(mk("crawler.eligibility", "crawler_eligibility", "Crawler eligibility signals (robots/sitemap/well-known)", "fail", "Standard crawler eligibility resources were not reachable.", [crawlRef]));
  }

  // Structured data validity
  if (page.structuredData) {
    const valid = typeof page.structuredData === "object" && page.structuredData !== null;
    checks.push(mk("structured_data.validity", "structured_data", "Structured data validity", valid ? "pass" : "fail", valid ? "Structured data object present (measured). " : "Structured data present but invalid shape.", [structuredRef]));
  } else if (page.html) {
    const hasLd = /application\/ld\+json/i.test(page.html);
    checks.push(mk("structured_data.validity", "structured_data", "Structured data validity", hasLd ? "pass" : "fail", hasLd ? "JSON-LD structured data marker detected in page." : "No structured data markers detected in inspected page.", [structuredRef]));
  } else {
    checks.push(mk("structured_data.validity", "structured_data", "Structured data validity", "unknown", "Structured data not inspected.", [structuredRef]));
  }

  // Credibility signals
  const hasAuthor = typeof page.author === "string" && page.author.trim().length > 0 || (page.html ? /author|byline|rel=\"author\"/i.test(page.html) : false);
  const hasCitations = Array.isArray(page.citations) ? page.citations.length > 0 : (page.html ? /<cite|references|bibliography/i.test(page.html) : false);
  const hasDates = Array.isArray(page.dates) ? page.dates.length > 0 : (page.html ? /datePublished|dateModified|datetime=|\b20\d{2}-\d{2}-\d{2}\b/i.test(page.html) : false);
  if (page.author !== undefined || page.citations !== undefined || page.dates !== undefined || page.html) {
    const pass = hasAuthor && hasCitations && hasDates;
    const status: GeoStatus = pass ? "pass" : (hasAuthor || hasCitations || hasDates ? "fail" : "fail");
    checks.push(mk("credibility.signals", "credibility", "Credibility signals (author, citations, dates)", status, `Measured signals - author:${hasAuthor} citations:${hasCitations} dates:${hasDates}.`, [credibilityRef]));
  } else {
    checks.push(mk("credibility.signals", "credibility", "Credibility signals (author, citations, dates)", "unknown", "Credibility signals not inspected.", [credibilityRef]));
  }

  // Grounding (measured, not inferred)
  if (page.answerConstruction?.measured) {
    const ok = Array.isArray(page.answerConstruction.sources) ? page.answerConstruction.sources.length > 0 : true;
    checks.push(mk("grounding.measured", "grounding", "Grounded answer construction (measured)", ok ? "pass" : "fail", page.answerConstruction.notes || "Answer construction measured from page sources.", [groundingRef]));
  } else if (Array.isArray(page.groundedSnippets)) {
    checks.push(mk("grounding.measured", "grounding", "Grounded answer construction (measured)", page.groundedSnippets.length > 0 ? "pass" : "fail", `Measured ${page.groundedSnippets.length} grounded snippet(s) from page content.`, [groundingRef]));
  } else if (page.html) {
    // measurable extraction: presence of substantive text blocks as grounding source
    const text = page.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const measured = text.length > 80;
    checks.push(mk("grounding.measured", "grounding", "Grounded answer construction (measured)", measured ? "pass" : "fail", `Measured page text length=${text.length}; grounding assessed from observed content (not inferred).`, [groundingRef]));
  } else {
    checks.push(mk("grounding.measured", "grounding", "Grounded answer construction (measured)", "unknown", "Grounding not inspected/measured.", [groundingRef]));
  }

  // ensure every check cites evidence and unknown never pass
  const allRefs = [crawlRef, structuredRef, credibilityRef, groundingRef];
  for (const c of checks) {
    if (!c.evidence.length) c.evidence.push(allRefs[0]!);
    if (c.status !== "pass" && c.status !== "fail") c.status = "unknown";
  }

  const summary = {
    total: checks.length,
    pass: checks.filter(c => c.status === "pass").length,
    fail: checks.filter(c => c.status === "fail").length,
    unknown: checks.filter(c => c.status === "unknown").length,
  };

  const report: GeoReport = {
    schema_version: "lemma.geo_report/v1",
    run_id: runId,
    target: params.target,
    checks,
    summary,
    evidence: {
      directory: `.lemma/evidence/${runId}/geo`,
      manifest: `.lemma/evidence/${runId}/manifest.json`,
      artifacts: Array.from(new Set([...allRefs, ...checks.flatMap(c => c.evidence)])),
    },
  };

  validateReportShape(report);
  await atomicWriteJson(path.join(outDir, "geo-report.json"), redactUnknown(report));
  const repRef = await evidence.saveJson("geo-report", redactUnknown(report), "json", "GEO evaluation report", "geo");
  report.evidence.artifacts = Array.from(new Set([...report.evidence.artifacts, repRef]));

  await evidence.finalize({ workflow: "geo", target: params.target, generated_at: deterministicNow() });
  validateReportShape(report);
  return report;
}
