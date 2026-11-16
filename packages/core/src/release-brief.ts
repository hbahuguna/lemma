import path from "node:path";

import { redactText, redactUnknown } from "./redaction.js";
import { atomicWriteFile } from "./state.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RELEASE_BRIEF_SCHEMA_VERSION = "lemma.release_brief/v1" as const;

export interface ReleaseBriefFinding {
  id: string;
  title: string;
  severity: string;
  check_id: string;
  evidence_level?: string;
}

export interface ReleaseBriefDecision {
  decision: "ship" | "review" | "hold" | "unknown";
  rationale: string;
  context: string;
}

export interface ReleaseBrief {
  schema_version: typeof RELEASE_BRIEF_SCHEMA_VERSION;
  run_id: string | null;
  decision: ReleaseBriefDecision;
  confidence: Record<string, unknown>;
  coverage: Record<string, unknown>;
  top_findings: ReleaseBriefFinding[];
  blockers: Array<Record<string, unknown>>;
  coverage_gaps: string[];
  next_steps: string[];
  markdown: string;
  html: string;
}

export interface BuildReleaseBriefOptions {
  topN?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v == null) return fallback;
  return String(v);
}

function severityRank(sev: string): number {
  switch (sev) {
    case "critical": return 5;
    case "high": return 4;
    case "medium": return 3;
    case "low": return 2;
    case "info": return 1;
    default: return 0;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decisionContext(decision: string): string {
  if (decision === "ship") return "Ship: evidence supports release within stated scope; known gaps remain visible.";
  if (decision === "review") return "Review: evidence is incomplete or accompanied by notable risk; human review required before shipping.";
  if (decision === "hold") return "Hold: critical risk, halt/failure, or insufficient confidence blocks release.";
  return "Unknown: decision could not be determined from report.";
}

export function releaseBriefSchemaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../schemas/release_brief/release_brief.v1.schema.json"),
    path.resolve(here, "../../schemas/release_brief/release_brief.v1.schema.json"),
    path.resolve(process.cwd(), "schemas/release_brief/release_brief.v1.schema.json"),
  ];
  for (const c of candidates) {
    try { readFileSync(c, "utf8"); return c; } catch { /* continue */ }
  }
  return candidates[0]!;
}

export function buildReleaseBrief(report: unknown, options: BuildReleaseBriefOptions = {}): ReleaseBrief {
  const topN = Math.max(0, Math.trunc(options.topN ?? 5));
  const redacted = redactUnknown(report) as unknown;
  const r = isRecord(redacted) ? redacted : {};

  const runId = typeof r.run_id === "string" ? r.run_id : null;
  const decisionObj = isRecord(r.decision) ? r.decision : {};
  const decisionValueRaw = asString(decisionObj.decision, "unknown");
  const decisionValue = (decisionValueRaw === "ship" || decisionValueRaw === "review" || decisionValueRaw === "hold") ? decisionValueRaw : "unknown";
  const rationale = asString(decisionObj.rationale, "");
  const confidence = isRecord(r.confidence) ? { ...r.confidence } : {};
  const coverage = isRecord(r.coverage) ? { ...r.coverage } : {};

  const findings = Array.isArray(r.findings) ? r.findings.filter(isRecord) : [];
  const sortedFindings = [...findings].sort((a, b) => {
    const sa = severityRank(asString(a.severity));
    const sb = severityRank(asString(b.severity));
    if (sa !== sb) return sb - sa;
    const ca = asString(a.created_at);
    const cb = asString(b.created_at);
    if (ca !== cb) return ca.localeCompare(cb);
    return asString(a.id).localeCompare(asString(b.id));
  });
  const top_findings: ReleaseBriefFinding[] = sortedFindings.slice(0, topN).map((f) => ({
    id: asString(f.id),
    title: asString(f.title),
    severity: asString(f.severity),
    check_id: asString(f.check_id),
    ...(asString((f as any).evidence_level) ? { evidence_level: asString((f as any).evidence_level) } : {}),
  }));

  const blockersRaw = Array.isArray(r.blockers) ? r.blockers.filter(isRecord) : [];
  const blockers = blockersRaw.map((b) => ({ ...b }));

  const coverage_gaps: string[] = [];
  for (const b of blockersRaw) {
    const persona = asString(b.persona, "unknown");
    const checkId = asString(b.check_id, "unknown");
    const boundary = asString(b.boundary, "blocked/refused");
    coverage_gaps.push(`Blocker (${persona}/${checkId}): ${boundary}`);
  }
  const invalid = Array.isArray(r.invalid_findings) ? r.invalid_findings : [];
  if (invalid.length > 0) {
    coverage_gaps.push(`${invalid.length} invalid/quarantined finding(s) excluded from scoring (coverage/contract gap).`);
  }
  if (asString(r.status) === "halted") {
    coverage_gaps.push("Run halted by kill switch; evidence set is intentionally incomplete.");
  } else if (asString(r.status) === "failed") {
    coverage_gaps.push("Run failed before producing a complete evidence set.");
  }

  // deterministic next steps
  const next_steps: string[] = [];
  if (decisionValue === "hold") {
    next_steps.push("Address blockers/critical issues and re-run to obtain sufficient, complete evidence before release.");
  } else if (decisionValue === "review") {
    next_steps.push("Review top findings and coverage gaps with stakeholders; remediate or accept risk with documented rationale before shipping.");
  } else if (decisionValue === "ship") {
    next_steps.push("Proceed with release within stated scope; monitor and address remaining findings/limitations as follow-up.");
  } else {
    next_steps.push("Inspect report validity and re-run assessment to determine a release decision.");
  }
  if (blockersRaw.length > 0) next_steps.push("Resolve or explicitly cover each blocker/refusal with compensating evidence.");
  if (top_findings.length > 0) next_steps.push("Triage top findings by severity and verify fixes with follow-up checks.");
  if (coverage_gaps.length === 0) next_steps.push("No explicit coverage gaps recorded; continue monitoring and trend tracking.");

  const briefBase: Omit<ReleaseBrief, "markdown" | "html"> = {
    schema_version: RELEASE_BRIEF_SCHEMA_VERSION,
    run_id: runId,
    decision: { decision: decisionValue, rationale, context: decisionContext(decisionValue) },
    confidence,
    coverage,
    top_findings,
    blockers,
    coverage_gaps,
    next_steps,
  };

  const markdown = renderReleaseBriefMarkdown(briefBase);
  const html = renderReleaseBriefHtml(briefBase);
  return { ...briefBase, markdown, html };
}

export function renderReleaseBriefMarkdown(brief: Omit<ReleaseBrief, "markdown" | "html">): string {
  const lines: string[] = [];
  lines.push("# Release Brief");
  lines.push("");
  lines.push(`- **Schema:** ${brief.schema_version}`);
  lines.push(`- **Run:** ${brief.run_id ?? "(unknown)"}`);
  lines.push(`- **Decision:** ${brief.decision.decision}`);
  lines.push(`- **Rationale:** ${brief.decision.rationale || "(none)"}`);
  lines.push(`- **Context:** ${brief.decision.context}`);
  const score = brief.confidence.score ?? "n/a";
  const covPct = brief.coverage.executed_pct ?? "n/a";
  lines.push(`- **Confidence:** ${String(score)}`);
  lines.push(`- **Coverage (executed %):** ${String(covPct)}`);
  lines.push("");
  lines.push("## Top findings");
  if (brief.top_findings.length === 0) {
    lines.push("- (none)");
  } else {
    for (const f of brief.top_findings) {
      const lvl = (f as any).evidence_level ? ` ${f.evidence_level}` : "";
      lines.push(`- [${f.severity}${lvl ? `/${lvl}` : ""}] ${f.title} (id: ${f.id}, check: ${f.check_id})`);
    }
  }
  lines.push("");
  lines.push("## Blockers / refusals (coverage gaps)");
  if (brief.coverage_gaps.length === 0) {
    lines.push("- (none)");
  } else {
    for (const g of brief.coverage_gaps) lines.push(`- ${g}`);
  }
  lines.push("");
  lines.push("## Next steps");
  for (const s of brief.next_steps) lines.push(`- ${s}`);
  lines.push("");
  return redactText(lines.join("\n"));
}

export function renderReleaseBriefHtml(brief: Omit<ReleaseBrief, "markdown" | "html">): string {
  const esc = (v: unknown) => escapeHtml(redactText(String(v ?? "")));
  const findings = brief.top_findings.length
    ? `<ul>${brief.top_findings.map((f) => `<li><strong>[${esc(f.severity)}${(f as any).evidence_level ? "/" + esc((f as any).evidence_level) : ""}]</strong> ${esc(f.title)} <small>(id: ${esc(f.id)}, check: ${esc(f.check_id)})</small></li>`).join("")}</ul>`
    : `<p>(none)</p>`;
  const gaps = brief.coverage_gaps.length ? `<ul>${brief.coverage_gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : `<p>(none)</p>`;
  const steps = brief.next_steps.length ? `<ol>${brief.next_steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : `<p>(none)</p>`;
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Lemma Release Brief</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:1.5rem;line-height:1.45}.card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:.75rem 0} .muted{color:#555}</style>
</head>
<body>
  <h1>Release Brief</h1>
  <div class="muted">Schema: ${esc(brief.schema_version)} · Run: ${esc(brief.run_id ?? "(unknown)")}</div>
  <div class="card"><h2>Decision</h2><p><strong>${esc(brief.decision.decision)}</strong> — ${esc(brief.decision.rationale || "(none)")}</p><p>${esc(brief.decision.context)}</p><p><strong>Confidence:</strong> ${esc(brief.confidence.score ?? "n/a")} · <strong>Coverage (executed %):</strong> ${esc(brief.coverage.executed_pct ?? "n/a")}</p></div>
  <div class="card"><h2>Top findings</h2>${findings}</div>
  <div class="card"><h2>Blockers / refusals (coverage gaps)</h2>${gaps}</div>
  <div class="card"><h2>Next steps</h2>${steps}</div>
</body></html>`;
  return redactText(html);
}

export async function writeReleaseBriefMarkdown(brief: ReleaseBrief, outPath: string): Promise<string> {
  await atomicWriteFile(outPath, brief.markdown, { encoding: "utf8" });
  return outPath;
}

export async function writeReleaseBriefHtml(brief: ReleaseBrief, outPath: string): Promise<string> {
  await atomicWriteFile(outPath, brief.html, { encoding: "utf8" });
  return outPath;
}
