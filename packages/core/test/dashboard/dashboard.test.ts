import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HarnessError, StateStore, startDashboard } from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
const prevEnv = process.env.LEMMA_DASHBOARD;

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.LEMMA_DASHBOARD;
  else process.env.LEMMA_DASHBOARD = prevEnv;
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function requestJson(urlStr: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let body: any = null;
          try { body = JSON.parse(data); } catch { body = null; }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: data });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function requestText(urlStr: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("LEM-143 dashboard", () => {
  it("binds only to 127.0.0.1 and rejects 0.0.0.0 with typed HarnessError", async () => {
    const root = await mkdtemp("lemma-dash-bind-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await expect(startDashboard({ stateStore: store, host: "0.0.0.0" })).rejects.toBeInstanceOf(HarnessError);

    const handle = await startDashboard({ stateStore: store, host: "127.0.0.1" });
    try {
      const u = new URL(handle.url);
      expect(u.hostname).toBe("127.0.0.1");
      expect(handle.token.length).toBeGreaterThan(10);
    } finally {
      await handle.close();
    }
  });

  it("requires token on every route (including /healthz) and returns 401 JSON for missing/mismatched token", async () => {
    const root = await mkdtemp("lemma-dash-auth-");
    tempDirs.push(root);
    const store = new StateStore(root);
    const handle = await startDashboard({ stateStore: store, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${new URL(handle.url).port}`;
      for (const p of ["/healthz", "/api/live", "/"]) {
        const missing = await requestJson(`${base}${p}`);
        expect(missing.status).toBe(401);
        expect(missing.body).toEqual({ ok: false, error: "unauthorized", message: "Missing or mismatched dashboard token." });
        expect((missing.headers["content-type"] || "").toString()).toContain("application/json");

        const bad = await requestJson(`${base}${p}?token=wrong`);
        expect(bad.status).toBe(401);
        expect(bad.body.error).toBe("unauthorized");
      }

      const ok = await requestJson(`${base}/healthz?token=${handle.token}`);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true, status: "ok" });

      const okHeader = await requestJson(`${base}/api/live`, { "x-lemma-dashboard-token": handle.token });
      expect(okHeader.status).toBe(200);
      expect(okHeader.body.ok).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("live view reflects current progress and safe no-op on missing state", async () => {
    const root = await mkdtemp("lemma-dash-live-");
    tempDirs.push(root);
    const store = new StateStore(root);

    // safe no-op when missing
    const handle = await startDashboard({ stateStore: store, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${new URL(handle.url).port}`;
      const empty = await requestJson(`${base}/api/live?token=${handle.token}`);
      expect(empty.status).toBe(200);
      expect(empty.body.ok).toBe(true);
      expect(empty.body.live.current_phase).toBeNull();
      expect(empty.body.live.current_check).toBeNull();
      expect(Array.isArray(empty.body.live.completed_checks)).toBe(true);

      await store.ensure();
      await store.saveProgress({
        run_id: "run_dash_1",
        status: "running",
        phases: [
          { name: "risk_analysis", status: "completed" },
          { name: "execution", status: "running", title: "Execution" },
        ],
        checks: [
          { id: "chk_running", title: "Running check", persona: "functional", status: "running", evidence: [".lemma/evidence/run_dash_1/inflight.txt"] },
          { id: "chk_done", title: "Done check", persona: "security", status: "passed", evidence: [".lemma/evidence/run_dash_1/done.txt"], actual: "ok" },
        ],
      });

      const live = await requestJson(`${base}/api/live?token=${handle.token}`);
      expect(live.status).toBe(200);
      expect(live.body.live.run_id).toBe("run_dash_1");
      expect(live.body.live.current_phase.name).toBe("execution");
      expect(live.body.live.current_check.id).toBe("chk_running");
      expect(live.body.live.in_flight_evidence_refs).toContain(".lemma/evidence/run_dash_1/inflight.txt");
      expect(live.body.live.completed_checks.map((c: any) => c.id)).toContain("chk_done");

      const page = await requestText(`${base}/?token=${handle.token}`);
      expect(page.status).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.text).toContain("Lemma Live Investigation");
    } finally {
      await handle.close();
    }
  });

  it("is disabled when LEMMA_DASHBOARD=off (no-op handle)", async () => {
    process.env.LEMMA_DASHBOARD = "off";
    const root = await mkdtemp("lemma-dash-off-");
    tempDirs.push(root);
    const store = new StateStore(root);
    const handle = await startDashboard({ stateStore: store, host: "127.0.0.1" });
    expect(handle.disabled).toBe(true);
    expect(handle.url).toBe("");
    expect(handle.token).toBe("");
    await handle.close();
  });
});
