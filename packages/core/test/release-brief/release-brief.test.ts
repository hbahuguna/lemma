import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  StateStore,
  buildReleaseBrief,
  startDashboard,
} from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function get(urlStr: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({ method: "GET", hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
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

function sampleReport(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "quality-harness.report/v1",
    run_id: "run_rel_1",
    status: "completed",
    decision: { decision: "review", rationale: "Needs review before ship." },
    confidence: { score: 62, band: "medium", coverage: 0.7 },
    coverage: { executed_pct: 80, blocked: 1 },
    findings: [
      { id: "f_high", title: "High issue", severity: "high", domain: "functional", persona: "functional", strength: "observed", consequence: "", location: "", reproduction: "", evidence: [], remediation: "", verification: "", check_id: "func.a", created_at: "2026-01-01T00:00:00Z" },
      { id: "f_crit", title: "Critical issue", severity: "critical", domain: "security", persona: "security", strength: "observed", consequence: "", location: "", reproduction: "", evidence: [], remediation: "", verification: "", check_id: "sec.a", created_at: "2026-01-01T00:00:01Z" },
      { id: "f_low", title: "Low issue", severity: "low", domain: "ui", persona: "ui", strength: "observed", consequence: "", location: "", reproduction: "", evidence: [], remediation: "", verification: "", check_id: "ui.a", created_at: "2026-01-01T00:00:02Z" },
    ],
    blockers: [
      { id: "b1", persona: "functional", check_id: "func.blocked", attempted_action: "run", boundary: "browser unavailable", unblock_evidence: [], covered_elsewhere: false, recorded_at: "2026-01-01T00:00:00Z" },
    ],
    invalid_findings: [{ id: "inv1", reason: "bad schema" }],
    limitations: [],
    evidence: { directory: ".lemma/evidence/run_rel_1", summary: {} },
    ...overrides,
  };
}

describe("LEM-145 release brief", () => {
  it("buildReleaseBrief generates deterministic structured+markdown+html brief conforming to schema shape", async () => {
    const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../schemas/release_brief/release_brief.v1.schema.json");
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
    const report = sampleReport();
    const a = buildReleaseBrief(report, { topN: 2 });
    const b = buildReleaseBrief(report, { topN: 2 });
    expect(a).toEqual(b);
    expect(a.schema_version).toBe("lemma.release_brief/v1");
    expect(a.decision.decision).toBe("review");
    expect(a.decision.context).toContain("Review");
    expect(a.confidence.score).toBe(62);
    expect(a.coverage.executed_pct).toBe(80);
    expect(a.top_findings.map((f) => f.id)).toEqual(["f_crit", "f_high"]); // severity-ranked, N=2
    expect(a.top_findings[0]).toMatchObject({ severity: "critical", check_id: "sec.a" });
    expect(a.blockers.length).toBe(1);
    expect(a.coverage_gaps.some((g) => g.includes("Blocker") && g.includes("browser unavailable"))).toBe(true);
    expect(a.coverage_gaps.some((g) => g.includes("invalid/quarantined"))).toBe(true);
    expect(a.next_steps.length).toBeGreaterThan(0);
    expect(a.markdown).toContain("# Release Brief");
    expect(a.html).toContain("<!doctype html>");

    // minimal schema conformance checks (committed schema fields)
    for (const req of schema.required) expect(Object.prototype.hasOwnProperty.call(a, req)).toBe(true);
    expect(a.decision).toHaveProperty("decision");
    expect(a.decision).toHaveProperty("rationale");
    expect(a.decision).toHaveProperty("context");
  });

  it("redacts sensitive values and handles reports with no blockers/findings", () => {
    const report = sampleReport({
      decision: { decision: "ship", rationale: "token=supersecret" },
      findings: [],
      blockers: [],
      invalid_findings: [],
      status: "completed",
    });
    const brief = buildReleaseBrief(report);
    const text = JSON.stringify(brief);
    expect(text).not.toContain("supersecret");
    expect(brief.top_findings).toEqual([]);
    expect(brief.blockers).toEqual([]);
    expect(brief.coverage_gaps.length).toBe(0);
    expect(brief.next_steps.some((s) => /No explicit coverage gaps/.test(s))).toBe(true);
    expect(brief.markdown).toContain("(none)");
  });

  it("dashboard /brief route serves brief with same token policy", async () => {
    const root = await mkdtemp("lemma-brief-dash-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await store.ensure();
    const report = sampleReport();
    const handle = await startDashboard({ stateStore: store, report, host: "127.0.0.1" });
    try {
      const port = new URL(handle.url).port;
      const base = `http://127.0.0.1:${port}`;
      const unauth = await get(`${base}/brief`);
      expect(unauth.status).toBe(401);

      const html = await get(`${base}/brief?token=${handle.token}`);
      expect(html.status).toBe(200);
      expect(String(html.headers["content-type"])).toContain("text/html");
      expect(html.text).toContain("Release Brief");
      expect(html.text).toContain("run_rel_1");
      expect(html.text).not.toContain("supersecret");

      const json = await get(`${base}/brief?token=${handle.token}&format=json`);
      expect(json.status).toBe(200);
      expect(json.body.schema_version).toBe("lemma.release_brief/v1");
      expect(json.body.run_id).toBe("run_rel_1");
    } finally {
      await handle.close();
    }
  });
});
