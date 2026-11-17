import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "../entitlement.js";
import { SteeredPlanStore, createDefaultSteeredPlan, steeredPlanSchema } from "../steered-plan.js";

export interface PlanRouteContext {
  root: string;
  license?: ProLicenseContext | null;
  method?: string;
  pathname?: string;
  body?: unknown;
}

export function renderPlanPageHtml(plan: unknown): string {
  const data = JSON.stringify(plan ?? createDefaultSteeredPlan(), null, 2).replace(/</g, "\\u003c");
  const schema = JSON.stringify(steeredPlanSchema, null, 2).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Lemma Steered Test Plan</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0b1020;color:#e8ecff}
  header{padding:16px 20px;border-bottom:1px solid #2a355f;background:#10183a;position:sticky;top:0}
  .muted{color:#9fb0e6} .card{margin:16px 20px;padding:14px;border:1px solid #2a355f;border-radius:10px;background:#121a3b}
  pre{white-space:pre-wrap;word-break:break-word;background:#0b1020;border:1px solid #2a355f;border-radius:8px;padding:10px;max-height:60vh;overflow:auto}
  h1{margin:0 0 4px 0;font-size:20px} h2{margin:0 0 8px 0;font-size:16px}
</style>
</head>
<body>
  <header>
    <h1>Steered Test Plan (Pro)</h1>
    <div class="muted">Token-protected, license-gated plan builder view. Uploads are validated, size-bounded, redacted, and referenced by hash (no raw credentials stored).</div>
  </header>
  <div class="card"><h2>Plan</h2><pre id="plan"></pre></div>
  <div class="card"><h2>Schema</h2><pre id="schema"></pre></div>
  <script>
    document.getElementById('plan').textContent = ${JSON.stringify(data)};
    document.getElementById('schema').textContent = ${JSON.stringify(schema)};
  </script>
</body>
</html>`;
}

export async function handlePlanRoute(ctx: PlanRouteContext): Promise<{ status: number; headers?: Record<string,string>; body: any; contentType?: string }> {
  if (!isProLicensed(ctx.license ?? null)) {
    const err = new ProUnavailableError("steered test plan (/plan)");
    return {
      status: 403,
      contentType: "application/json; charset=utf-8",
      body: err.toPayload ? err.toPayload() : { ok: false, error: { type: err.name, code: (err as any).errorCode || "pro_unavailable", message: err.message } },
    };
  }

  const store = new SteeredPlanStore({ root: ctx.root, license: ctx.license ?? null });
  const method = (ctx.method || "GET").toUpperCase();

  if (method === "GET") {
    const plan = await store.load();
    return { status: 200, contentType: "text/html; charset=utf-8", body: renderPlanPageHtml(plan) };
  }

  if (method === "POST") {
    const payload = (ctx.body && typeof ctx.body === "object") ? ctx.body as Record<string, unknown> : {};
    if (payload.upload && typeof payload.upload === "object") {
      const u = payload.upload as Record<string, unknown>;
      const content = typeof u.content === "string" ? u.content : "";
      const result = await store.addUpload({ kind: (u.kind === "doc" ? "doc" : "spec"), name: String(u.name || "upload"), content, ...(u.content_type ? { content_type: String(u.content_type) } : {}) });
      return { status: 200, contentType: "application/json; charset=utf-8", body: { ok: true, plan: result.plan, upload: result.upload } };
    }
    const next = payload.plan ?? payload;
    const saved = await store.save(next, { reason: "dashboard_update" });
    return { status: 200, contentType: "application/json; charset=utf-8", body: { ok: true, plan: saved } };
  }

  return { status: 405, contentType: "application/json; charset=utf-8", body: { ok: false, error: "method_not_allowed" } };
}
