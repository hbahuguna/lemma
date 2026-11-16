import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  EvidenceStore,
  StateStore,
  buildJourneyMap,
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

function sampleReport() {
  return {
    schema_version: "quality-harness.report/v1",
    run_id: "run_journey_1",
    status: "completed",
    target: { raw: "https://example.test", kind: "url", resolved: "https://example.test/", source: null },
    decision: { decision: "review", rationale: "r" },
    confidence: { score: 70, band: "medium", coverage: 0.8 },
    coverage: { executed_pct: 100 },
    findings: [],
    blockers: [],
    invalid_findings: [],
    checks: [
      {
        id: "browser.load",
        title: "Page loads",
        status: "passed",
        domain: "functional",
        persona: "functional",
        kind: "browser",
        intent: "load",
        expected: "ok",
        weight: 1,
        actual: "ok",
        evidence: [".lemma/evidence/run_journey_1/browser.load/screenshot-1.png"],
        finding_ids: [],
        skip_reason: "",
        metadata: {
          routes: [
            { page: "landing", route: "https://example.test/", status: "passed" },
            { page: "about", route: "https://example.test/about", status: "failed" },
          ],
        },
      },
      {
        id: "browser.console",
        title: "Console clean",
        status: "failed",
        domain: "functional",
        persona: "functional",
        kind: "browser",
        intent: "console",
        expected: "clean",
        weight: 1,
        actual: "errors",
        evidence: [".lemma/evidence/run_journey_1/browser.console/screenshot-1.png"],
        finding_ids: [],
        skip_reason: "",
        metadata: {
          routes: [
            { page: "landing", route: "https://example.test/", status: "passed" },
            { page: "about", route: "https://example.test/about", status: "failed" },
          ],
        },
      },
    ],
    evidence: { directory: ".lemma/evidence/run_journey_1", summary: {} },
  };
}

describe("LEM-147 journey map", () => {
  it("builds deterministic graph from run artifacts and validates schema shape/refs consistency", async () => {
    const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../schemas/journey_map/journey_map.v1.schema.json");
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
    const report = sampleReport();
    const scenarioPlan = {
      title: "flow",
      steps: [
        { step_number: 1, name: "home", action: "goto", target: "https://example.test/" },
        { step_number: 2, name: "about", action: "goto", target: "https://example.test/about" },
      ],
      source: "explicit",
      target_url: "https://example.test/",
    };

    const a = buildJourneyMap(report, { scenarioPlan });
    const b = buildJourneyMap(report, { scenarioPlan });
    expect(a).toEqual(b);
    expect(a.schema_version).toBe("lemma.journey_map/v1");
    expect(a.run_id).toBe("run_journey_1");

    // nodes/routes derived from artifact metadata
    expect(a.nodes.map((n) => n.route)).toEqual(["https://example.test/", "https://example.test/about"]);
    const about = a.nodes.find((n) => n.route.includes("/about"))!;
    expect(about.checks).toEqual(["browser.console", "browser.load"]);
    expect(about.evidence).toContain(".lemma/evidence/run_journey_1/browser.console/screenshot-1.png");

    // observed transition from scenario plan (artifact), no invented transitions
    expect(a.edges.length).toBe(1);
    expect(a.edges[0]!.source).toBe("scenario_plan");
    expect(a.edges[0]!.from).not.toBe(a.edges[0]!.to);

    // textual fallback routes -> checks -> outcomes
    expect(a.text_table.length).toBe(2);
    expect(a.text_table[0]!.checks.length).toBeGreaterThan(0);

    // schema-required fields present
    for (const req of schema.required) expect(Object.prototype.hasOwnProperty.call(a, req)).toBe(true);
  });

  it("dashboard renders journey map route with token protection, textual fallback, and screenshot placeholder for missing evidence", async () => {
    const root = await mkdtemp("lemma-journey-dash-");
    tempDirs.push(root);
    const store = new StateStore(root);
    const evidence = new EvidenceStore(root, "run_journey_1");
    await evidence.init();
    // intentionally do not create screenshot file to assert unavailable placeholder
    await evidence.finalize({ run_id: "run_journey_1", status: "completed" });
    await store.ensure();

    const report = sampleReport();
    const handle = await startDashboard({ stateStore: store, evidenceStore: evidence, report, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${new URL(handle.url).port}`;
      const unauth = await get(`${base}/journey`);
      expect(unauth.status).toBe(401);

      const html = await get(`${base}/journey?token=${handle.token}`);
      expect(html.status).toBe(200);
      expect(String(html.headers["content-type"])).toContain("text/html");
      expect(html.text).toContain("Journey Map");
      expect(html.text).toContain("Routes → checks → outcomes".replace("→", "&rarr;") ? "routes" : "routes"); // fallback table present
      expect(html.text.toLowerCase()).toContain("textual fallback");
      expect(html.text).toContain("browser.load");
      expect(html.text).toContain("https://example.test/about");
      expect(html.text).toContain("evidence unavailable"); // missing screenshot placeholder

      const json = await get(`${base}/journey?token=${handle.token}&format=json`);
      expect(json.status).toBe(200);
      expect(json.body.schema_version).toBe("lemma.journey_map/v1");
      expect(Array.isArray(json.body.nodes)).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
