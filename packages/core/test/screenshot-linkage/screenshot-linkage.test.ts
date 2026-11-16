import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { EvidenceStore, StateStore, buildHtmlReport, startDashboard } from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function get(urlStr: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({ method: "GET", hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let body: any = null;
        try { body = JSON.parse(data); } catch { body = null; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: data });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("LEM-144 screenshot linkage (dashboard + HTML report)", () => {
  it("dashboard exposes screenshot refs and serves evidence with missing-evidence fallback semantics", async () => {
    const root = await mkdtemp("lemma-shot-dash-");
    tempDirs.push(root);
    const store = new StateStore(root);
    const evidence = new EvidenceStore(root, "run_shot_1");
    await evidence.init();
    const shot = await evidence.saveScreenshot("s", Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), "shot", "browser.load");
    await evidence.finalize({ run_id: "run_shot_1", status: "completed" });
    await store.ensure();
    await store.saveProgress({
      run_id: "run_shot_1",
      status: "running",
      phases: [{ name: "execution", status: "running" }],
      checks: [
        { id: "browser.load", title: "Load", persona: "functional", status: "passed", evidence: [shot], actual: "ok" },
        { id: "browser.console", title: "Console", persona: "functional", status: "passed", evidence: [".lemma/evidence/run_shot_1/missing.png"], actual: "ok" },
      ],
    });

    const handle = await startDashboard({ stateStore: store, evidenceStore: evidence, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${new URL(handle.url).port}`;
      const live = await get(`${base}/api/live?token=${handle.token}`);
      expect(live.status).toBe(200);
      const checks = live.body.live.completed_checks;
      const load = checks.find((c: any) => c.id === "browser.load");
      expect(load.screenshot_ref).toContain("/browser.load/screenshot-1.png");

      const art = await get(`${base}/api/evidence?token=${handle.token}&path=${encodeURIComponent(load.screenshot_ref)}`);
      expect(art.status).toBe(200);
      expect(String(art.headers["content-type"])).toContain("image");

      const missing = await get(`${base}/api/evidence?token=${handle.token}&path=${encodeURIComponent(".lemma/evidence/run_shot_1/missing.png")}`);
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe("not_found");

      const page = await get(`${base}/?token=${handle.token}`);
      expect(page.text).toContain("evidence unavailable"); // placeholder/fallback present in UI
      expect(page.text).toContain("thumb");
    } finally {
      await handle.close();
    }
  });

  it("HTML report embeds/links screenshot refs and notes unavailable/missing evidence clearly", async () => {
    const root = await mkdtemp("lemma-shot-html-");
    tempDirs.push(root);
    const evidence = new EvidenceStore(root, "run_shot_2");
    await evidence.init();
    const shot = await evidence.saveScreenshot("s", Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), "shot", "browser.load");
    await evidence.finalize({ run_id: "run_shot_2", status: "completed" });

    const report = {
      schema_version: "quality-harness.report/v1",
      generated_at: "2026-11-16T00:00:00Z",
      run_id: "run_shot_2",
      status: "completed",
      decision: { decision: "review", rationale: "r" },
      confidence: { score: 50, band: "medium", coverage: 1, rationale: "", limitations: [], penalties: {}, domain_scores: {}, breakdown: {}, gate: { status: "warn" } },
      findings: [{ id: "f1", title: "t", severity: "high", domain: "functional", persona: "functional", strength: "observed", consequence: "c", location: "x", reproduction: "r", evidence: [shot], remediation: "m", verification: "v", check_id: "browser.load", created_at: "2026-11-16T00:00:00Z" }],
      blockers: [], invalid_findings: [], contract_failures: { total: 0, by_persona: {}, degraded_personas: [] },
      checks: [{ id: "browser.load", title: "Load", domain: "functional", persona: "functional", kind: "browser", intent: "i", expected: "e", status: "passed", weight: 1, actual: "a", evidence: [shot, ".lemma/evidence/run_shot_2/missing.png"], finding_ids: ["f1"], skip_reason: "", metadata: {} }],
      coverage: { total_checks: 1, executed: 1, passed: 1, failed: 0, blocked: 0, skipped: 0, error: 0, planned_not_run: 0, blockers: 0, blockers_covered_elsewhere: 0, blockers_uncovered: 0, blockers_by_persona: {}, executed_pct: 100, by_domain: {} },
      trend: { baseline: true, previous_run_id: null, new: [], resolved: [], persistent: [], score_delta: 0, coverage_delta: 0 },
      policy: { id: "advisory-v1", version: "1.0" },
      evidence: { directory: ".lemma/evidence/run_shot_2", summary: { count: 1, total_bytes: 10 } },
      limitations: [],
    };

    const html = await buildHtmlReport(report, evidence);
    expect(html).toContain(shot);
    expect(html).toMatch(/data:image\/png|view embedded/); // embedded screenshot
    expect(html).toContain("missing.png");
    expect(html).toMatch(/unreadable evidence file|link/i); // clear unavailable/note for missing
  });
});
