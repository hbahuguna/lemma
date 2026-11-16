import path from "node:path";

import { atomicWriteFile } from "./state.js";
import { redactText, redactUnknown } from "./redaction.js";
import type { EvidenceStore } from "./evidence.js";
import { REPORT_SCHEMA } from "./report.js";

export const HTML_REPORT_SCHEMA_VERSION = "lemma.report.html/v1" as const;
/** Documented size ceiling for typical runs (soft guidance); large embedded blobs fall back to relative links. */
export const HTML_REPORT_EMBED_MAX_BYTES = 200 * 1024; // 200 KiB

function escapeHtml(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function redactForHtml(value: unknown): unknown {
  return redactUnknown(value);
}

function redactStr(value: unknown): string {
  return redactText(typeof value === "string" ? value : value == null ? "" : String(value));
}

function fmtJson(value: unknown): string {
  const redacted = redactForHtml(value);
  return escapeHtml(JSON.stringify(redacted, null, 2));
}

async function resolveEvidenceHref(
  evidencePath: string,
  evidenceStore: EvidenceStore | undefined,
): Promise<{ href: string; embedded: boolean; note?: string }> {
  // evidencePath is expected to be relative like ".lemma/evidence/..." (from EvidenceStore entries)
  if (typeof evidencePath !== "string" || !evidencePath) {
    return { href: "#", embedded: false, note: "missing path" };
  }
  if (path.isAbsolute(evidencePath) || evidencePath.includes("..")) {
    return { href: "#", embedded: false, note: "unsafe path (absolute or traversal) refused" };
  }
  if (!evidenceStore) {
    return { href: escapeHtml(evidencePath), embedded: false, note: "no evidence store provided" };
  }
  try {
    const abs = path.join(evidenceStore.root, evidencePath.replaceAll("/", path.sep));
    const relFromStoreRoot = path.relative(evidenceStore.root, abs);
    if (relFromStoreRoot.startsWith("..") || path.isAbsolute(relFromStoreRoot)) {
      return { href: "#", embedded: false, note: "path escapes root refused" };
    }
    const fsMod = await import("node:fs/promises");
    const buf = await fsMod.readFile(abs);
    if (buf.byteLength > HTML_REPORT_EMBED_MAX_BYTES) {
      // Documented escaped relative href (relative to report location if placed alongside root)
      return { href: escapeHtml(evidencePath), embedded: false, note: `too large (${buf.byteLength} bytes), linked as relative path` };
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".json" ? "application/json" : ext === ".html" ? "text/html" : "application/octet-stream";
    if (mime.startsWith("image/")) {
      return { href: `data:${mime};base64,${buf.toString("base64")}`, embedded: true };
    }
    if (mime === "application/json" || mime === "text/html") {
      // embed as data URL for self-contained; text content shown via link
      const text = buf.toString("utf8");
      const red = redactText(text);
      return { href: `data:${mime};charset=utf-8,${encodeURIComponent(red)}`, embedded: true, note: "embedded (redacted)" };
    }
    return { href: `data:${mime};base64,${buf.toString("base64")}`, embedded: true };
  } catch {
    return { href: escapeHtml(evidencePath), embedded: false, note: "unreadable evidence file" };
  }
}


function isAbsolutePathString(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("file://")) return true;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return true;
  // also catch obvious POSIX abs paths embedded
  return /^\/(Users|home|var|etc|tmp|private|opt)\//.test(value);
}

function assertNoAbsolutePaths(value: unknown, pth = "$"): void {
  if (typeof value === "string") {
    // allow relative evidence-like paths and URLs? URLs are not filesystem absolute paths we must refuse except file://
    if (isAbsolutePathString(value)) {
      throw new Error(`HTML report refuses to include absolute path at ${pth}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoAbsolutePaths(v, `${pth}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoAbsolutePaths(v, `${pth}.${k}`);
    }
  }
}

function renderSection(title: string, body: string): string {
  return `<section class="section"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function renderKvTable(obj: Record<string, unknown> | undefined | null): string {
  if (!obj || typeof obj !== "object") return `<p class="empty">(none)</p>`;
  const entries = Object.entries(obj);
  if (entries.length === 0) return `<p class="empty">(none)</p>`;
  const rows = entries
    .map(([k, v]) => {
      const val = typeof v === "object" && v !== null ? `<pre class="json">${fmtJson(v)}</pre>` : `<code>${escapeHtml(redactStr(v))}</code>`;
      return `<tr><th>${escapeHtml(k)}</th><td>${val}</td></tr>`;
    })
    .join("");
  return `<table class="kv"><tbody>${rows}</tbody></table>`;
}

export interface BuildHtmlReportOptions {
  /** Title override */
  title?: string;
  /** If true, omit embedded data URIs in deterministic contexts by forcing links (for tests). */
  forceLinksOnly?: boolean;
}

export async function buildHtmlReport(
  report: unknown,
  evidenceStore?: EvidenceStore,
  options: BuildHtmlReportOptions = {},
): Promise<string> {
  const rawReport = isRecord(report) ? (report as Record<string, unknown>) : {};
  assertNoAbsolutePaths(rawReport);
  const r = redactForHtml(rawReport) as Record<string, unknown>;
  const title = escapeHtml(options.title ?? `Lemma Release Confidence Report — ${redactStr(r.run_id ?? "unknown")}`);
  const generatedAt = escapeHtml(redactStr(r.generated_at ?? ""));
  const schemaVersion = escapeHtml(redactStr(r.schema_version ?? REPORT_SCHEMA));

  // Deterministic ordering assumptions: buildReport already sorts findings/blockers.
  const findings = Array.isArray(r.findings) ? r.findings : [];
  const blockers = Array.isArray(r.blockers) ? r.blockers : [];
  const invalidFindings = Array.isArray(r.invalid_findings) ? r.invalid_findings : [];
  const checks = Array.isArray(r.checks) ? r.checks : [];
  const limitations = Array.isArray(r.limitations) ? r.limitations : [];

  // Build evidence index from report.evidence.summary or known paths
  const evidenceSummary = isRecord(r.evidence) && isRecord(r.evidence.summary) ? (r.evidence.summary as Record<string, unknown>) : {};
  const evidenceDir = isRecord(r.evidence) ? redactStr((r.evidence as Record<string, unknown>).directory) : "";

  // Resolve evidence refs mentioned in findings/checks
  const evidenceRefs = new Set<string>();
  for (const f of findings) {
    if (!isRecord(f)) continue;
    const ev = f.evidence;
    if (Array.isArray(ev)) for (const e of ev) {
      if (typeof e === "string") {
        if (path.isAbsolute(e) || isAbsolutePathString(e)) throw new Error(`HTML report refuses to include absolute path in evidence ref: ${e}`);
        evidenceRefs.add(e);
      }
    }
  }
  for (const c of checks) {
    if (!isRecord(c)) continue;
    const ev = c.evidence;
    if (Array.isArray(ev)) for (const e of ev) {
      if (typeof e === "string") {
        if (path.isAbsolute(e) || isAbsolutePathString(e)) throw new Error(`HTML report refuses to include absolute path in evidence ref: ${e}`);
        evidenceRefs.add(e);
      }
    }
  }

  const evidenceLinksHtmlParts: string[] = [];
  for (const ref of Array.from(evidenceRefs).sort()) {
    if (options.forceLinksOnly) {
      evidenceLinksHtmlParts.push(`<li><a href="${escapeHtml(ref)}">${escapeHtml(ref)}</a></li>`);
      continue;
    }
    const resolved = await resolveEvidenceHref(ref, evidenceStore);
    const isImageRef = /\.(png|jpg|jpeg|webp)(?:$|[?#])/i.test(ref) || /screenshot/i.test(ref);
    if (resolved.href.startsWith("data:image/")) {
      evidenceLinksHtmlParts.push(`<li><code>${escapeHtml(ref)}</code><br/><img class="thumb" alt="evidence screenshot" src="${resolved.href}"/></li>`);
    } else if (resolved.href.startsWith("data:")) {
      evidenceLinksHtmlParts.push(`<li><code>${escapeHtml(ref)}</code> <a href="${resolved.href}">view embedded</a>${resolved.note ? ` <span class="note">${escapeHtml(resolved.note)}</span>` : ""}</li>`);
    } else if (isImageRef && /unreadable|missing|unavailable|refused/i.test(resolved.note || "")) {
      evidenceLinksHtmlParts.push(`<li><code>${escapeHtml(ref)}</code> <span class="note">evidence unavailable</span></li>`);
    } else {
      evidenceLinksHtmlParts.push(`<li><code>${escapeHtml(ref)}</code> <a href="${resolved.href}">${resolved.note ?? "link"}</a>${isImageRef && resolved.note ? ` <span class="note">${escapeHtml(resolved.note)}</span>` : ""}</li>`);
    }
  }

  const findingsHtml = findings.length
    ? `<table class="findings"><thead><tr><th>Severity</th><th>ID</th><th>Check</th><th>Title</th><th>Evidence</th><th>Location</th></tr></thead><tbody>${findings
        .map((f) => {
          if (!isRecord(f)) return "";
          const sev = escapeHtml(redactStr(f.severity));
          const id = escapeHtml(redactStr(f.id));
          const checkId = escapeHtml(redactStr(f.check_id));
          const t = escapeHtml(redactStr(f.title));
          const loc = escapeHtml(redactStr(f.location));
          const ev = Array.isArray(f.evidence) ? f.evidence.filter((x): x is string => typeof x === "string").map((x) => escapeHtml(x)).join(", ") : "";
          return `<tr><td class="sev sev-${sev.toLowerCase()}">${sev}</td><td>${id}</td><td>${checkId}</td><td>${t}</td><td class="ev">${ev || "—"}</td><td>${loc || "—"}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : `<p class="empty">No findings.</p>`;

  const blockersHtml = blockers.length
    ? `<table class="blockers"><thead><tr><th>Persona</th><th>Check</th><th>Attempted action</th><th>Boundary</th><th>Unblock evidence</th></tr></thead><tbody>${blockers
        .map((b) => {
          if (!isRecord(b)) return "";
          const persona = escapeHtml(redactStr(b.persona));
          const checkId = escapeHtml(redactStr(b.check_id));
          const action = escapeHtml(redactStr(b.attempted_action));
          const boundary = escapeHtml(redactStr(b.boundary));
          const ue = Array.isArray(b.unblock_evidence) ? b.unblock_evidence.filter((x): x is string => typeof x === "string").map((x) => escapeHtml(x)).join("; ") : "";
          return `<tr><td>${persona}</td><td>${checkId}</td><td>${action}</td><td>${boundary}</td><td>${ue || "—"}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : `<p class="empty">No blockers.</p>`;

  const invalidHtml = invalidFindings.length
    ? `<pre class="json">${fmtJson(invalidFindings)}</pre>`
    : `<p class="empty">No invalid/quarantined findings.</p>`;

  const contractHealthHtml = renderKvTable(isRecord(r.contract_failures) ? r.contract_failures : {});

  const decisionObj = isRecord(r.decision) ? r.decision : {};
  const confidenceObj = isRecord(r.confidence) ? r.confidence : {};
  const summaryHtml = `
    <div class="grid">
      <div><strong>Run ID:</strong> <code>${escapeHtml(redactStr(r.run_id))}</code></div>
      <div><strong>Status:</strong> ${escapeHtml(redactStr(r.status))}</div>
      <div><strong>Decision:</strong> ${escapeHtml(redactStr(decisionObj.decision))}</div>
      <div><strong>Rationale:</strong> ${escapeHtml(redactStr(decisionObj.rationale))}</div>
      <div><strong>Confidence score:</strong> ${escapeHtml(String(confidenceObj.score ?? "n/a"))}</div>
      <div><strong>Band:</strong> ${escapeHtml(redactStr(confidenceObj.band))}</div>
      <div><strong>Coverage (exec %):</strong> ${escapeHtml(redactStr(isRecord(r.coverage) ? r.coverage.executed_pct : "n/a"))}</div>
    </div>`;

  const trendObj = isRecord(r.trend) ? r.trend : {};
  const trendHtml = renderKvTable(trendObj);

  const policyObj = isRecord(r.policy) ? r.policy : {};
  const policyHtml = renderKvTable(policyObj);

  const evidenceHtml = `
    <p><strong>Evidence directory (relative):</strong> <code>${escapeHtml(evidenceDir || "(none)")}</code></p>
    ${renderKvTable(evidenceSummary)}
    ${evidenceLinksHtmlParts.length ? `<h3>Referenced artifacts</h3><ul class="evidence-links">${evidenceLinksHtmlParts.join("")}</ul>` : "<p class=\"empty\">No referenced artifacts resolved from report evidence refs.</p>"}
  `;

  const limitationsHtml = limitations.length
    ? `<ul>${limitations.map((l) => `<li>${escapeHtml(redactStr(l))}</li>`).join("")}</ul>`
    : `<p class="empty">No recorded limitations.</p>`;

  const css = `
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.4; margin: 2rem; }
    h1 { margin-bottom: .25rem; }
    .meta { color: #555; font-size: .9rem; margin-bottom: 1.5rem; }
    .section { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
    .section h2 { margin-top: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: .5rem 1.5rem; }
    table { border-collapse: collapse; width: 100%; font-size: .9rem; }
    th, td { border: 1px solid #ccc; padding: .4rem .5rem; text-align: left; vertical-align: top; }
    th { background: rgba(0,0,0,.04); }
    .json { white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,.03); padding: .5rem; border-radius: 4px; overflow-x: auto; }
    .empty { color: #666; font-style: italic; }
    .sev-critical { font-weight: 700; }
    .sev-high { font-weight: 600; }
    .ev { max-width: 320px; word-break: break-word; }
    .thumb { max-width: 320px; max-height: 240px; display: block; margin-top: .25rem; }
    .note { color: #666; font-size: .85rem; }
    ul.evidence-links { padding-left: 1.25rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  `;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>${css}</style>
</head>
<body>
  <header>
    <h1>${title}</h1>
    <div class="meta">Generated: ${generatedAt || "(unknown)"} · Report schema: ${schemaVersion} (HTML export ${HTML_REPORT_SCHEMA_VERSION}) · Deterministic sections follow JSON report ordering; volatile timestamps may vary as documented.</div>
  </header>
  ${renderSection("Summary & Decision", summaryHtml)}
  ${renderSection("Policy", policyHtml)}
  ${renderSection("Trend", trendHtml)}
  ${renderSection("Confidence / Coverage Details", `<pre class="json">${fmtJson({ confidence: confidenceObj, coverage: r.coverage })}</pre>`)}
  ${renderSection("Findings", findingsHtml)}
  ${renderSection("Blockers", blockersHtml)}
  ${renderSection("Invalid / Quarantined Findings", invalidHtml)}
  ${renderSection("Contract Health", contractHealthHtml)}
  ${renderSection("Limitations", limitationsHtml)}
  ${renderSection("Evidence", evidenceHtml)}
  ${renderSection("Full Report (redacted JSON)", `<details><summary>Show full redacted report JSON</summary><pre class="json">${fmtJson(r)}</pre></details>`)}
</body>
</html>
`;
  // Final defense-in-depth redaction pass to prevent secret leakage in any rendered/embedded content.
  return redactText(html).replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
}

export async function writeHtmlReport(
  report: unknown,
  outPath: string,
  evidenceStore?: EvidenceStore,
  options: BuildHtmlReportOptions = {},
): Promise<string> {
  const html = await buildHtmlReport(report, evidenceStore, options);
  await atomicWriteFile(outPath, html, { encoding: "utf8" });
  return outPath;
}
