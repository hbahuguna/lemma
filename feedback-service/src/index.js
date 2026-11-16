import http from "node:http";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Minimal self-hosted feedback review service (Node built-ins only).
 * Off by default; must be started explicitly (e.g. `lemma feedback serve`).
 */

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { __invalid_json: true }; }
}

export async function startFeedbackService(options = {}) {
  if (options.enabled !== true) {
    throw new Error("Feedback review service is off by default and must be explicitly enabled.");
  }
  const root = options.root ? path.resolve(options.root) : process.cwd();
  const port = Number.isInteger(options.port) ? options.port : 8787;
  const host = options.host || "127.0.0.1";
  const baseUrl = options.baseUrl || `http://${host}:${port}`;
  const brand = options.brand || "lemma";

  // Lazy-load core APIs from workspace source when running in-repo; fallback to package name if installed.
  let core;
  try {
    core = await import("@lemma/core");
  } catch {
    // try local relative path (repo dev)
    core = await import(new URL("../../packages/core/src/feedback.ts", import.meta.url));
  }
  const { createFeedbackRequest, ingestFeedback, readFeedbackRequest } = core;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", baseUrl);
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, service: "lemma-feedback-service", brand });
      }

      if (req.method === "POST" && url.pathname === "/requests") {
        const body = await readBody(req);
        if (body.__invalid_json) return json(res, 400, { error: "invalid_json" });
        const { runId, scope, reviewers, ttlMs } = body || {};
        const result = await createFeedbackRequest({ runId, scope: scope || {}, reviewers: reviewers || [], root, ...(ttlMs ? { ttlMs } : {}) });
        // branded invitation links (token scoped + expiring); token never logged
        const links = result.invitations.map((inv) => ({
          reviewer_id: inv.reviewer_id,
          expires_at: inv.expires_at,
          url: `${baseUrl}/review/${encodeURIComponent(inv.request_id)}?token=${encodeURIComponent(inv.token)}`,
          brand,
        }));
        return json(res, 201, {
          request: { request_id: result.request.request_id, run_id: result.request.run_id, created_at: result.request.created_at },
          invitations: links,
        });
      }

      if (req.method === "GET" && /^\/requests\/[^/]+$/.test(url.pathname)) {
        const requestId = decodeURIComponent(url.pathname.split("/")[2] || "");
        const request = await readFeedbackRequest(root, requestId);
        // never expose token hashes? keep internal; return safe view
        return json(res, 200, {
          request_id: request.request_id,
          run_id: request.run_id,
          scope: request.scope,
          reviewers: request.reviewers,
          created_at: request.created_at,
          updated_at: request.updated_at,
          status: request.status,
        });
      }

      if (req.method === "POST" && /^\/requests\/[^/]+\/responses$/.test(url.pathname)) {
        const requestId = decodeURIComponent(url.pathname.split("/")[2] || "");
        const token = url.searchParams.get("token") || (req.headers["x-invitation-token"] ? String(req.headers["x-invitation-token"]) : "");
        const body = await readBody(req);
        if (body.__invalid_json) return json(res, 400, { error: "invalid_json" });
        const response = body && body.response ? body.response : body;
        const result = await ingestFeedback({ requestId, response, root, ...(token ? { invitationToken: token } : {}) });
        return json(res, result.idempotent ? 200 : 201, result);
      }

      return json(res, 404, { error: "not_found" });
    } catch (err) {
      const msg = err && typeof err.message === "string" ? err.message : "error";
      const status = /not found/i.test(msg) ? 404 : /expired|invalid|unscoped|schema_version|Invalid feedback/i.test(msg) ? 400 : 500;
      return json(res, status, { error: msg });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    url: baseUrl,
    host,
    port,
    root,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

export default { startFeedbackService };
