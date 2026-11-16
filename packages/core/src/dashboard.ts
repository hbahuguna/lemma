import http from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";

import { HarnessError } from "./errors.js";
import type { StateStore } from "./state-store.js";
import type { EvidenceStore } from "./evidence.js";

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

  if (!progress || typeof progress !== "object") {
    return { ...safeNoopLiveView(), evidence, report_summary: report ? summarizeReport(report) : null };
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
    .map((c: any) => ({
      id: c.id ?? null,
      title: c.title ?? null,
      owner: c.persona ?? c.owner ?? null,
      status: c.status ?? null,
      evidence: Array.isArray(c.evidence) ? c.evidence : [],
      actual: typeof c.actual === "string" ? c.actual : "",
    }));

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
    },
    evidence,
  };
}

function summarizeReport(report: unknown): Record<string, unknown> | null {
  if (!report || typeof report !== "object") return null;
  const r = report as any;
  const decision = r.decision && typeof r.decision === "object" ? r.decision : {};
  const confidence = r.confidence && typeof r.confidence === "object" ? r.confidence : {};
  return {
    run_id: r.run_id ?? null,
    status: r.status ?? null,
    decision: decision.decision ?? r.decision ?? null,
    confidence_score: confidence.score ?? null,
    coverage: r.coverage ?? null,
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
  <div class="card" style="margin-top:1rem"><h2>Completed checks</h2><div id="checks" class="muted">(none)</div></div>
<script>
(async function(){
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
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
      const checks = live.completed_checks || [];
      if(!checks.length){ document.getElementById('checks').innerHTML = '<span class="muted">(none)</span>'; }
      else {
        const rows = checks.map(c => '<tr><td>'+esc(c.id)+'</td><td>'+esc(c.status)+'</td><td>'+esc(c.owner)+'</td><td>'+esc(c.title)+'</td><td>'+esc((c.evidence||[]).join(', '))+'</td></tr>').join('');
        document.getElementById('checks').innerHTML = '<table><thead><tr><th>ID</th><th>Status</th><th>Owner</th><th>Title</th><th>Evidence refs</th></tr></thead><tbody>'+rows+'</tbody></table>';
      }
    } catch(e){ document.getElementById('status').textContent = 'Error loading live view'; }
  }
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g, s=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[s])); }
  await tick();
  setInterval(tick, 1000);
})();
</script>
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
