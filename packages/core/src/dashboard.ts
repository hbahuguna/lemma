import http from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";

import { HarnessError, StateError } from "./errors.js";
import type { StateStore } from "./state-store.js";
import type { EvidenceStore } from "./evidence.js";
import { buildReleaseBrief } from "./release-brief.js";
import { buildJourneyMap } from "./journey-map.js";
import { loadSettings, saveSettings } from "./settings.js";
import { readJsonFile } from "./state.js";

export interface DashboardHandle {
  url: string;
  token: string;
  close(): Promise<void>;
  /** true when dashboard startup was intentionally disabled */
  disabled?: boolean;
}

export interface StartDashboardOptions {
  stateStore: StateStore;
  evidenceStore?: EvidenceStore;
  report?: unknown;
  host?: string;
  port?: number;
  /** injectable for tests */
  now?: () => string;
}

function isLoopback127(host: string): boolean {
  return host === "127.0.0.1";
}

function isDashboardDisabledByEnv(): boolean {
  const v = (process.env.LEMMA_DASHBOARD ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "disabled";
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(payload);
}

function getToken(req: http.IncomingMessage, url: URL): string | null {
  const header = req.headers["x-lemma-dashboard-token"];
  if (typeof header === "string" && header) return header;
  if (Array.isArray(header) && header[0]) return header[0];
  const q = url.searchParams.get("token");
  return q && q.length > 0 ? q : null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function safeNoopLiveView(): Record<string, unknown> {
  return {
    ok: true,
    live: {
      current_phase: null,
      current_check: null,
      in_flight_evidence_refs: [],
      completed_checks: [],
      report_summary: null,
    },
    note: "No active state available (safe no-op).",
  };
}


async function readForeverMission(root: string, runId?: string | null): Promise<Record<string, unknown> | null> {
  const base = path.join(root, ".lemma", "forever");
  const tryRead = async (id: string) => {
    try {
      const data = await readJsonFile<any>(path.join(base, id, "mission.json"));
      return data && typeof data === "object" ? data as Record<string, unknown> : null;
    } catch { return null; }
  };
  if (runId) return await tryRead(runId);
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const dirs = entries.filter((e: any) => e.isDirectory()).map((e: any) => e.name as string).sort();
    for (let i = dirs.length - 1; i >= 0; i--) {
      const m = await tryRead(dirs[i]!);
      if (m) return m;
    }
  } catch { /* ignore */ }
  return null;
}

async function readLiveView(options: StartDashboardOptions): Promise<Record<string, unknown>> {
  const { stateStore, evidenceStore, report } = options;
  let progress: any = null;
  try {
    progress = await stateStore.loadProgress<any>();
  } catch {
    progress = null;
  }

  // Evidence manifest summary (read-only via EvidenceStore APIs only)
  let evidence: Record<string, unknown> | null = null;
  if (evidenceStore) {
    try {
      evidence = await evidenceStore.readManifestSummary();
    } catch {
      evidence = null;
    }
  }

  const foreverMission = await readForeverMission(stateStore.root, progress && typeof progress === "object" ? (progress.run_id ?? null) : null).catch(() => null) ?? await readForeverMission(stateStore.root, null).catch(() => null);
  if (!progress || typeof progress !== "object") {
    const r: any = report ?? {};
    const notes = Array.isArray(r.review_notes) ? r.review_notes : [];
    const summary = report ? summarizeReport(report) : null;
    const noop = safeNoopLiveView() as any;
    if (noop.live && typeof noop.live === "object") noop.live.report_summary = summary;
    return {
      ...noop,
      evidence,
      report_summary: summary,
      review_notes: notes.filter((n: any) => n && (n.status === "contested" || n.type === "review_note")),
      release_decision: r.release_decision ?? null,
      forever_mission: foreverMission,
    };
  }

  const phases = Array.isArray(progress.phases) ? progress.phases : [];
  const currentPhase = phases.find((p: any) => p && typeof p === "object" && p.status === "running")
    ?? phases.find((p: any) => p && typeof p === "object" && p.status === "in_progress")
    ?? null;

  const checks = Array.isArray(progress.checks) ? progress.checks : [];
  const currentCheckRaw = checks.find((c: any) => c && typeof c === "object" && (c.status === "running" || c.status === "in_progress")) ?? null;
  const current_check = currentCheckRaw ? {
    id: currentCheckRaw.id ?? null,
    title: currentCheckRaw.title ?? null,
    owner: currentCheckRaw.persona ?? currentCheckRaw.owner ?? null,
    status: currentCheckRaw.status ?? null,
    domain: currentCheckRaw.domain ?? null,
  } : null;

  const completedStatuses = new Set(["passed", "failed", "blocked", "skipped", "error", "completed"]);
  const completed_checks = checks
    .filter((c: any) => c && typeof c === "object" && completedStatuses.has(String(c.status)))
    .map((c: any) => {
      const evidenceRefs = Array.isArray(c.evidence) ? c.evidence.filter((x: any) => typeof x === "string") : [];
      const screenshot_ref = evidenceRefs.find((r: string) => /screenshot|\.png$|\.jpg$|\.jpeg$|\.webp$/i.test(r)) ?? null;
      const redaction_note = (c.metadata && typeof c.metadata === "object" && (c.metadata.screenshot_redacted || c.metadata.redaction_note))
        ? (c.metadata.redaction_note || "Screenshot redacted/unavailable due to redaction policy.")
        : null;
      return {
        id: c.id ?? null,
        title: c.title ?? null,
        owner: c.persona ?? c.owner ?? null,
        status: c.status ?? null,
        evidence: evidenceRefs,
        screenshot_ref,
        redaction_note,
        actual: typeof c.actual === "string" ? c.actual : "",
      };
    });

  // in-flight evidence refs: from current check or recent evidence entries if available
  let in_flight_evidence_refs: string[] = [];
  if (currentCheckRaw && Array.isArray(currentCheckRaw.evidence)) {
    in_flight_evidence_refs = currentCheckRaw.evidence.filter((x: any) => typeof x === "string");
  }
  if (in_flight_evidence_refs.length === 0 && evidenceStore) {
    try {
      in_flight_evidence_refs = await evidenceStore.listEvidencePaths();
    } catch {
      // ignore
    }
  }

  return {
    ok: true,
    live: {
      run_id: progress.run_id ?? null,
      status: progress.status ?? null,
      current_phase: currentPhase ? {
        name: currentPhase.name ?? currentPhase.id ?? null,
        status: currentPhase.status ?? null,
        title: currentPhase.title ?? null,
      } : null,
      current_check,
      in_flight_evidence_refs,
      completed_checks,
      report_summary: report ? summarizeReport(report) : summarizeReport(progress.report ?? null),
      review_notes: (() => { const r: any = report ?? (progress as any).report ?? {}; const notes = Array.isArray(r.review_notes) ? r.review_notes : []; return notes.filter((n: any) => n && (n.status === "contested" || n.type === "review_note")); })(),
    },
    evidence,
    release_decision: (() => { const r: any = report ?? (progress as any).report ?? {}; return r.release_decision ?? null; })(),
    forever_mission: foreverMission,
  };
}

function summarizeReport(report: unknown): Record<string, unknown> | null {
  if (!report || typeof report !== "object") return null;
  const r = report as any;
  const decision = r.decision && typeof r.decision === "object" ? r.decision : {};
  const confidence = r.confidence && typeof r.confidence === "object" ? r.confidence : {};
  const reviewNotes = Array.isArray(r.review_notes) ? r.review_notes : [];
  const contested = reviewNotes.filter((n: any) => n && (n.status === "contested" || n.type === "review_note"));
  const rd = r.release_decision && typeof r.release_decision === "object" ? r.release_decision : null;
  return {
    run_id: r.run_id ?? null,
    status: r.status ?? null,
    decision: decision.decision ?? r.decision ?? null,
    confidence_score: confidence.score ?? null,
    coverage: r.coverage ?? null,
    review_notes_count: reviewNotes.length,
    contested_count: contested.length,
    release_decision: rd ? { decision: (rd as any).decision ?? null, decision_id: (rd as any).decision_id ?? null } : null,
  };
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Lemma Dashboard</title>
<style>
  body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:1.5rem;line-height:1.4}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}
  .card{border:1px solid #ccc;border-radius:8px;padding:1rem}
  h1{margin:0 0 .5rem 0} h2{margin:.25rem 0 .5rem 0;font-size:1rem}
  pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;padding:.5rem;border-radius:4px;max-height:40vh;overflow:auto}
  table{border-collapse:collapse;width:100%;font-size:.9rem} th,td{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;vertical-align:top}
  .muted{color:#666}
  .thumb{max-width:160px;max-height:120px;border:1px solid #ddd;border-radius:4px;cursor:pointer;display:block;margin:.25rem 0}
  .placeholder{display:inline-block;padding:.5rem .75rem;border:1px dashed #c33;color:#a00;background:#fff5f5;border-radius:4px;font-size:.85rem}
  .panel{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;padding:1rem;z-index:10}
  .panel.open{display:flex}
  .panel img{max-width:95vw;max-height:90vh;background:#fff;border-radius:6px}
  .panel .close{position:absolute;top:1rem;right:1rem;background:#fff;border:1px solid #ccc;border-radius:4px;padding:.25rem .5rem;cursor:pointer}
</style>
</head>
<body>
  <h1>Lemma Live Investigation</h1>
  <div class="muted">Local dashboard (127.0.0.1, token-protected). Read-only view.</div>
  <div id="status" class="muted" style="margin:.5rem 0 1rem 0">Loading…</div>
  <div class="grid">
    <div class="card"><h2>Current phase</h2><pre id="phase">(none)</pre></div>
    <div class="card"><h2>Current check</h2><pre id="check">(none)</pre></div>
    <div class="card"><h2>Report summary</h2><pre id="report">(none)</pre></div>
  </div>
  <div class="card" style="margin-top:1rem"><h2>In-flight evidence refs</h2><pre id="inflight">(none)</pre></div>
  <div class="card" style="margin-top:1rem"><h2>Forever mission report</h2><pre id="foreverMission">(none)</pre></div>
  <div class="card" style="margin-top:1rem"><h2>Explicit release decision</h2><pre id="releaseDecision">(none)</pre></div>
  <div class="card" style="margin-top:1rem"><h2>Review notes (contested)</h2><pre id="reviews">(none)</pre></div>
  <div class="card" style="margin-top:1rem"><h2>Completed checks</h2><div id="checks" class="muted">(none)</div></div>
  <div id="shotPanel" class="panel"><button class="close" id="shotClose">Close</button><img id="shotImg" alt="Screenshot evidence"/></div>
<script>
(async function(){
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const brief = document.getElementById('briefLink');
  if (brief) brief.href = '/brief?token=' + encodeURIComponent(token);
  const journey = document.getElementById('journeyLink');
  if (journey) journey.href = '/journey?token=' + encodeURIComponent(token);
  const settings = document.getElementById('settingsLink');
  if (settings) settings.href = '/settings?token=' + encodeURIComponent(token);
  const pro = document.getElementById('proLink');
  if (pro) pro.href = '/pro?token=' + encodeURIComponent(token);
  const headers = token ? {'x-lemma-dashboard-token': token} : {};
  async function tick(){
    try{
      const res = await fetch('/api/live' + (token ? ('?token=' + encodeURIComponent(token)) : ''), { headers, cache: 'no-store' });
      const data = await res.json();
      if(!res.ok){ document.getElementById('status').textContent = 'Unauthorized or unavailable: ' + (data && data.error ? data.error : res.status); return; }
      const live = data.live || {};
      document.getElementById('status').textContent = 'Run: ' + (live.run_id||'n/a') + ' · Status: ' + (live.status||'n/a') + ' · Updated: ' + new Date().toISOString();
      document.getElementById('phase').textContent = live.current_phase ? JSON.stringify(live.current_phase, null, 2) : '(none)';
      document.getElementById('check').textContent = live.current_check ? JSON.stringify(live.current_check, null, 2) : '(none)';
      document.getElementById('report').textContent = live.report_summary ? JSON.stringify(live.report_summary, null, 2) : '(none)';
      const inflight = live.in_flight_evidence_refs || [];
      document.getElementById('inflight').textContent = inflight.length ? inflight.join('\\n') : '(none)';

      const reviewNotes = (data.review_notes || (live && live.review_notes) || []);
      const contested = Array.isArray(reviewNotes) ? reviewNotes.filter(n => n && (n.status === 'contested' || n.type === 'review_note')) : [];
      const reviewsEl = document.getElementById('reviews');
      if (reviewsEl) reviewsEl.textContent = contested.length ? JSON.stringify(contested, null, 2) : '(none)';
      const rd = data.release_decision || (live && live.report_summary && live.report_summary.release_decision) || null;
      const rdEl = document.getElementById('releaseDecision');
      if (rdEl) rdEl.textContent = rd ? JSON.stringify(rd, null, 2) : '(none)';
      const fm = data.forever_mission || null;
      const fmEl = document.getElementById('foreverMission');
      if (fmEl) fmEl.textContent = fm ? JSON.stringify(fm, null, 2) : '(none)';
      const checks = live.completed_checks || [];
      if(!checks.length){ document.getElementById('checks').innerHTML = '<span class="muted">(none)</span>'; }
      else {
        const rows = checks.map(c => {
          const shot = c.screenshot_ref;
          let shotHtml = '<span class="muted">(none)</span>';
          if (c.redaction_note) {
            shotHtml = '<span class="placeholder">'+esc(c.redaction_note)+'</span>';
          } else if (shot) {
            const src = '/api/evidence?path=' + encodeURIComponent(shot) + (token ? ('&token=' + encodeURIComponent(token)) : '');
            shotHtml = '<img class="thumb" data-shot="'+esc(src)+'" src="'+esc(src)+'" alt="Screenshot thumbnail" onerror="this.outerHTML=\'<span class=\\'placeholder\\'>evidence unavailable</span>\'"/>';
          }
          const refs = esc((c.evidence||[]).join(', '));
          return '<tr><td>'+esc(c.id)+'</td><td>'+esc(c.status)+'</td><td>'+esc(c.owner)+'</td><td>'+esc(c.title)+'</td><td>'+shotHtml+'<div class="muted">'+refs+'</div></td></tr>';
        }).join('');
        document.getElementById('checks').innerHTML = '<table><thead><tr><th>ID</th><th>Status</th><th>Owner</th><th>Title</th><th>Evidence refs</th></tr></thead><tbody>'+rows+'</tbody></table>';
      }
    } catch(e){ document.getElementById('status').textContent = 'Error loading live view'; }
  }
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g, s=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[s])); }
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('thumb') && t.dataset && t.dataset.shot) {
      const panel = document.getElementById('shotPanel');
      const img = document.getElementById('shotImg');
      img.src = t.dataset.shot;
      panel.classList.add('open');
    }
    if (t && t.id === 'shotClose') {
      document.getElementById('shotPanel').classList.remove('open');
      document.getElementById('shotImg').removeAttribute('src');
    }
  });
  await tick();
  setInterval(tick, 1000);
})();
</script>
</body>
</html>`;
}


function isAllowedOrigin(origin: string | undefined, host: string): boolean {
  if (!origin) return true; // non-browser/non-CORS clients may omit; token still required
  try {
    const u = new URL(origin);
    const h = u.hostname;
    return h === host || h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

function settingsPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Lemma Settings</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:1.5rem;line-height:1.4}
    .card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:.75rem 0;max-width:720px}
    label{display:block;margin:.5rem 0 .2rem}
    input[type=text],input[type=number]{width:100%;max-width:420px;padding:.35rem}
    .row{margin:.35rem 0}
    .muted{color:#555}
    .error{color:#a00}
    .ok{color:#060}
    button{margin-top:.75rem;padding:.4rem .75rem}
  </style>
</head>
<body>
  <h1>Settings</h1>
  <p class="muted">Protected dashboard settings. Changes apply to future runs.</p>
  <div class="card">
    <form id="settingsForm">
      <h2>Budget</h2>
      <label>Minutes <input id="budgetMinutes" type="number" min="0" step="1"/></label>
      <label>Max checks <input id="budgetMaxChecks" type="number" min="0" step="1"/></label>
      <h2>Focus</h2>
      <label>Project <input id="focusProject" type="text" placeholder="(null/empty)"/></label>
      <label>URL <input id="focusUrl" type="text" placeholder="(null/empty)"/></label>
      <h2>Analytics</h2>
      <label><input id="analyticsEnabled" type="checkbox"/> Enabled</label>
      <label>Endpoint <input id="analyticsEndpoint" type="text" placeholder="(null/empty)"/></label>
      <button type="submit">Save settings</button>
      <div id="msg" class="muted"></div>
    </form>
  </div>
<script>
(async () => {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const msg = document.getElementById('msg');
  function setMsg(text, cls){ msg.className = cls || 'muted'; msg.textContent = text; }
  async function load() {
    const res = await fetch('/settings?token=' + encodeURIComponent(token) + '&format=json', { headers: { 'x-lemma-dashboard-token': token } });
    const data = await res.json();
    if (!res.ok) { setMsg((data && data.message) || 'Failed to load settings', 'error'); return; }
    const s = data.settings || data;
    document.getElementById('budgetMinutes').value = s.budget?.minutes ?? 0;
    document.getElementById('budgetMaxChecks').value = s.budget?.maxChecks ?? 0;
    document.getElementById('focusProject').value = s.focus?.project ?? '';
    document.getElementById('focusUrl').value = s.focus?.url ?? '';
    document.getElementById('analyticsEnabled').checked = !!(s.analytics && s.analytics.enabled);
    document.getElementById('analyticsEndpoint').value = s.analytics?.endpoint ?? '';
    setMsg('Loaded.', 'muted');
  }
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const toNullable = (v) => { const t = String(v || '').trim(); return t === '' ? null : t; };
    const payload = {
      schema_version: 'lemma.settings/v1',
      budget: {
        minutes: Number(document.getElementById('budgetMinutes').value),
        maxChecks: Number(document.getElementById('budgetMaxChecks').value),
      },
      focus: {
        project: toNullable(document.getElementById('focusProject').value),
        url: toNullable(document.getElementById('focusUrl').value),
      },
      analytics: {
        enabled: !!document.getElementById('analyticsEnabled').checked,
        endpoint: toNullable(document.getElementById('analyticsEndpoint').value),
      }
    };
    const res = await fetch('/settings?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lemma-dashboard-token': token },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setMsg((data && data.message) || JSON.stringify(data), 'error'); return; }
    setMsg('Saved. Applies to future runs.', 'ok');
  });
  await load();
})();
</script>
</body>
</html>`;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new StateError("Invalid JSON body", { code: "state_error", details: { reason: "invalid_json" } });
  }
}


function escapeHtmlServer(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

async function journeyMapPageHtml(options: StartDashboardOptions, token: string): Promise<string> {
  const report = options.report ?? null;
  const map = buildJourneyMap(report ?? {}, {});
  const evidenceStore = options.evidenceStore;
  const shotUrl = (ref: string) => `/api/evidence?path=${encodeURIComponent(ref)}&token=${encodeURIComponent(token)}`;

  const nodes = map.nodes;
  const nodePos = new Map<string, { x: number; y: number }>();
  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(Math.max(1, nodes.length)))));
  const spacingX = 260;
  const spacingY = 140;
  nodes.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    nodePos.set(n.id, { x: 140 + col * spacingX, y: 80 + row * spacingY });
  });
  const width = Math.max(800, 220 + cols * spacingX);
  const height = Math.max(320, 160 + Math.ceil(nodes.length / cols) * spacingY);

  const svgEdges = map.edges.map((e) => {
    const a = nodePos.get(e.from);
    const b = nodePos.get(e.to);
    if (!a || !b) return "";
    const label = escapeHtmlServer(`${e.label} (${e.source})`);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 - 6;
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#666" stroke-width="2" marker-end="url(#arrow)" />
      <text x="${mx}" y="${my}" font-size="11" text-anchor="middle" fill="#333">${label}</text>`;
  }).join("\n");

  const renderShot = async (ref: string | null): Promise<string> => {
    if (!ref) return `<span class="placeholder">evidence unavailable</span>`;
    if (!evidenceStore) return `<span class="placeholder">evidence unavailable</span>`;
    try {
      const art = await evidenceStore.readEvidenceArtifact(ref);
      if (!art) return `<span class="placeholder">evidence unavailable</span>`;
      const src = shotUrl(ref);
      return `<a href="${src}" target="_blank" rel="noopener"><img class="thumb" src="${src}" alt="Screenshot for ${escapeHtmlServer(ref)}"/></a>`;
    } catch {
      return `<span class="placeholder">evidence unavailable</span>`;
    }
  };

  const svgNodesParts: string[] = [];
  for (const n of nodes) {
    const p = nodePos.get(n.id)!;
    const route = escapeHtmlServer(n.route);
    const checksLabel = escapeHtmlServer(`${n.checks.length} check(s)`);
    const shot = await renderShot(n.screenshot_ref);
    svgNodesParts.push(`<g>
      <rect x="${p.x - 110}" y="${p.y - 34}" rx="8" ry="8" width="220" height="68" fill="#f7f7fb" stroke="#444" />
      <title>${route}</title>
      <text x="${p.x}" y="${p.y - 8}" font-size="12" text-anchor="middle">${route.length > 34 ? route.slice(0, 31) + "..." : route}</text>
      <text x="${p.x}" y="${p.y + 10}" font-size="11" text-anchor="middle" fill="#444">${checksLabel}</text>
    </g>
    <foreignObject x="${p.x - 60}" y="${p.y + 38}" width="120" height="90"><div xmlns="http://www.w3.org/1999/xhtml">${shot}</div></foreignObject>`);
  }

  const tableRows = map.text_table.map((row) => {
    const checks = row.checks.length === 0
      ? `<tr><td>${escapeHtmlServer(row.route)}</td><td colspan="3" class="muted">(no checks)</td></tr>`
      : row.checks.map((c, idx) => `<tr>${idx === 0 ? `<td rowspan="${row.checks.length}">${escapeHtmlServer(row.route)}</td>` : ""}<td><code>${escapeHtmlServer(c.id)}</code></td><td>${escapeHtmlServer(c.status)}</td><td>${escapeHtmlServer(c.title || "")}</td></tr>`).join("");
    return checks;
  }).join("");

  const edgeRows = map.edges.length === 0
    ? `<tr><td colspan="4" class="muted">(no observed transitions)</td></tr>`
    : (await Promise.all(map.edges.map(async (e) => {
        const from = nodes.find((n) => n.id === e.from)?.route ?? e.from;
        const to = nodes.find((n) => n.id === e.to)?.route ?? e.to;
        const shot = await renderShot(e.screenshot_ref);
        return `<tr><td>${escapeHtmlServer(from)}</td><td>${escapeHtmlServer(to)}</td><td>${escapeHtmlServer(e.label)} <span class="muted">(${escapeHtmlServer(e.source)})</span></td><td>${shot}</td></tr>`;
      }))).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Lemma Journey Map</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:1rem 1.25rem;line-height:1.4}
    .muted{color:#666}
    .placeholder{display:inline-block;padding:.4rem .6rem;border:1px dashed #c33;color:#a00;background:#fff5f5;border-radius:4px;font-size:.8rem}
    .thumb{max-width:110px;max-height:80px;border:1px solid #ddd;border-radius:4px;display:block}
    table{border-collapse:collapse;width:100%;margin:.5rem 0}
    th,td{border:1px solid #ddd;padding:.35rem .45rem;text-align:left;vertical-align:top}
    th{background:#f3f3f3}
    .card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:.75rem 0}
    svg{max-width:100%;height:auto;border:1px solid #ddd;border-radius:8px;background:#fff}
  </style>
</head>
<body>
  <h1>Journey Map</h1>
  <p class="muted">Derived deterministically from run artifacts (scenario plans and browser evidence/check metadata). No inferred transitions. Schema: ${escapeHtmlServer(map.schema_version)} · Run: ${escapeHtmlServer(map.run_id ?? "(unknown)")}</p>

  <div class="card">
    <h2>Graph (accessible visual)</h2>
    ${nodes.length === 0 ? '<p class="muted">No route/view nodes available from run artifacts.</p>' : `<svg role="img" aria-label="Journey map graph showing routes, transitions, and checks" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#666" /></marker></defs>
      ${svgEdges}
      ${svgNodesParts.join("\n")}
    </svg>`}
    <p class="muted">Textual fallback below provides routes → checks → outcomes and observed transitions.</p>
  </div>

  <div class="card">
    <h2>Textual fallback: routes → checks → outcomes</h2>
    <table aria-label="Routes to checks and outcomes">
      <thead><tr><th>Route / view</th><th>Check ID</th><th>Status / outcome</th><th>Title</th></tr></thead>
      <tbody>${tableRows || '<tr><td colspan="4" class="muted">(none)</td></tr>'}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>Observed transitions (edges)</h2>
    <table aria-label="Observed journey transitions">
      <thead><tr><th>From</th><th>To</th><th>Label</th><th>Evidence</th></tr></thead>
      <tbody>${edgeRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}


function proPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Lemma Pro (Informational)</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:1.5rem;line-height:1.5;color:#111;max-width:860px}
    .card{border:1px solid #d0d7de;border-radius:10px;padding:1rem 1.1rem;margin:1rem 0;background:#fff}
    .muted{color:#555}
    .badge{display:inline-block;padding:.15rem .5rem;border:1px solid #999;border-radius:999px;font-size:.85rem}
    ul{margin:.4rem 0 .2rem 1.2rem}
    a{color:#0b5fff}
    .notice{background:#f6f8fa}
  </style>
</head>
<body>
  <h1>Lemma Pro <span class="badge">Informational</span></h1>
  <p class="muted">This page is informational only. It does not start a checkout, does not collect data, and does not require an account.</p>

  <div class="card">
    <h2>Pro edition features (summary)</h2>
    <ul>
      <li>Team-oriented release confidence workflows and collaboration features (planned/optional tier).</li>
      <li>Advanced reporting, policy, and evidence review experiences for larger organizations.</li>
      <li>Hosted management and support options where available, while the open-source core remains fully usable.</li>
      <li>Commercial entitlements and packaging are defined separately; no Pro capability is enabled by viewing this page.</li>
    </ul>
  </div>

  <div class="card">
    <h2>Pricing summary</h2>
    <p><strong>Pricing:</strong> To be announced. Contact/sales details and plan options will be provided via the official learn-more link when available.</p>
    <p class="muted">No billing, purchase flow, or subscription changes occur in this local dashboard.</p>
  </div>

  <div class="card notice">
    <h2>Learn more</h2>
    <p>Learn more about Lemma Pro: <a href="https://lemma.dev/pro">https://lemma.dev/pro</a></p>
    <p class="muted">This is a navigation/information link only. Opening it is your choice; this page makes no external calls by itself.</p>
  </div>

  <div class="card">
    <h2>Privacy and behavior</h2>
    <ul>
      <li>No external scripts, stylesheets, fonts, or images are loaded by this page.</li>
      <li>No checkout flow is started and no account is required.</li>
      <li>No telemetry or additional data collection is performed by this page beyond the existing localhost dashboard token protection.</li>
    </ul>
  </div>
</body>
</html>`;
}

export async function startDashboard(options: StartDashboardOptions): Promise<DashboardHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback127(host)) {
    throw new HarnessError("Dashboard server must bind to 127.0.0.1 only.", {
      code: "harness_error",
      details: { host },
    });
  }
  if (isDashboardDisabledByEnv()) {
    return {
      url: "",
      token: "",
      disabled: true,
      async close() { /* no-op */ },
    };
  }

  const token = randomBytes(24).toString("hex");
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const reqUrl = new URL(req.url || "/", `http://${host}`);
      // Token required on every route including /healthz
      const provided = getToken(req, reqUrl);
      if (!provided || !timingSafeEqualStr(provided, token)) {
        json(res, 401, { ok: false, error: "unauthorized", message: "Missing or mismatched dashboard token." });
        return;
      }

      if (method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html")) {
        const body = htmlPage();
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(body);
        return;
      }

      if (method === "GET" && reqUrl.pathname === "/healthz") {
        json(res, 200, { ok: true, status: "ok" });
        return;
      }

      if (method === "GET" && reqUrl.pathname === "/api/live") {
        const view = await readLiveView(options);
        json(res, 200, view);
        return;
      }

      if (reqUrl.pathname === "/settings") {
        const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
        if (!isAllowedOrigin(origin, host)) {
          json(res, 403, { ok: false, error: "forbidden", message: "Disallowed origin." });
          return;
        }
        if (method === "GET") {
          const format = (reqUrl.searchParams.get("format") || "html").toLowerCase();
          try {
            const settings = await loadSettings(options.stateStore);
            if (format === "json") {
              json(res, 200, { ok: true, settings });
              return;
            }
            res.statusCode = 200;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.setHeader("cache-control", "no-store");
            res.end(settingsPageHtml());
            return;
          } catch (err) {
            if (err instanceof StateError) {
              json(res, 500, { ok: false, error: "state_error", message: err.message, details: err.details ?? {} });
              return;
            }
            throw err;
          }
        }
        if (method === "POST") {
          try {
            const body = await readJsonBody(req);
            let candidate: unknown = body;
            if (body && typeof body === "object" && !Array.isArray(body) && "settings" in (body as any)) {
              candidate = (body as any).settings;
            }
            const saved = await saveSettings(options.stateStore, candidate, { source: "dashboard" });
            json(res, 200, { ok: true, settings: saved });
            return;
          } catch (err) {
            if (err instanceof StateError) {
              const msg = err.message || "Invalid settings";
              const isCorrupt = /Corrupt|unreadable/i.test(msg);
              json(res, isCorrupt ? 500 : 400, {
                ok: false,
                error: "state_error",
                message: msg,
                details: (err as any).details ?? {},
              });
              return;
            }
            json(res, 400, { ok: false, error: "invalid_request", message: err instanceof Error ? err.message : String(err) });
            return;
          }
        }
        json(res, 405, { ok: false, error: "method_not_allowed" });
        return;
      }

      if (method === "GET" && (reqUrl.pathname === "/pro" || reqUrl.pathname === "/dashboard/pro")) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(proPageHtml());
        return;
      }

      if (method === "GET" && (reqUrl.pathname === "/journey" || reqUrl.pathname === "/map")) {
        const format = (reqUrl.searchParams.get("format") || "html").toLowerCase();
        const report = options.report ?? null;
        const map = buildJourneyMap(report ?? {}, {});
        if (format === "json") {
          json(res, 200, map);
          return;
        }
        const body = await journeyMapPageHtml({ ...options, report }, token);
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(body);
        return;
      }

      if (method === "GET" && reqUrl.pathname === "/brief") {
        const format = (reqUrl.searchParams.get("format") || "html").toLowerCase();
        const report = options.report ?? null;
        if (!report) {
          json(res, 404, { ok: false, error: "not_found", message: "No completed report available for release brief." });
          return;
        }
        const brief = buildReleaseBrief(report, { topN: 5 });
        if (format === "json") {
          json(res, 200, brief);
          return;
        }
        if (format === "md" || format === "markdown") {
          res.statusCode = 200;
          res.setHeader("content-type", "text/markdown; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(brief.markdown);
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(brief.html);
        return;
      }

      if (method === "GET" && reqUrl.pathname === "/api/evidence") {
        const relPath = reqUrl.searchParams.get("path") || "";
        if (!options.evidenceStore || !relPath) {
          json(res, 404, { ok: false, error: "not_found", message: "Evidence unavailable." });
          return;
        }
        try {
          const out = await options.evidenceStore.readEvidenceArtifact(relPath);
          if (!out) {
            json(res, 404, { ok: false, error: "not_found", message: "evidence unavailable" });
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", out.contentType || "application/octet-stream");
          res.setHeader("cache-control", "no-store");
          res.end(out.data);
          return;
        } catch {
          json(res, 404, { ok: false, error: "not_found", message: "evidence unavailable" });
          return;
        }
      }

      // No write endpoints in this task
      if (method !== "GET" && method !== "HEAD") {
        json(res, 405, { ok: false, error: "method_not_allowed" });
        return;
      }

      json(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      json(res, 500, { ok: false, error: "internal_error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => reject(err));
    server.listen(options.port ?? 0, host, () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (options.port ?? 0);
  const url = `http://${host}:${port}/?token=${token}`;

  return {
    url,
    token,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
