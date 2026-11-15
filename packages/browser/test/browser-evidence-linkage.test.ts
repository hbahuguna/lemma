import { createServer, type Server } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  EvidenceStore,
  RELEASE_CONFIDENCE,
  RunStatus,
  buildReport,
  normalizeConfidence,
  recordCheckOutcome,
  type Check,
  type CheckOutcome,
  type RunStateDomain,
} from "@lemma/core";
import { runBrowserChecks } from "../src/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../..");
const demoWebDir = resolve(repoRoot, "examples/demo-web");

function contentType(p: string): string {
  switch (extname(p).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    default: return "application/octet-stream";
  }
}

async function serveDemoWeb(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        let p = decodeURIComponent(reqUrl.pathname);
        if (p === "/") p = "/index.html";
        const filePath = resolve(demoWebDir, `.${p}`);
        if (!filePath.startsWith(demoWebDir)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        const data = await readFile(filePath);
        res.writeHead(200, { "content-type": contentType(filePath) });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind demo-web server");
  const url = `http://127.0.0.1:${addr.port}/`;
  return {
    url,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function canLaunchPlaywrightChromium(): Promise<boolean> {
  try {
    const pw = await import("playwright");
    const chromium = (pw as { chromium?: { launch?: (opts?: unknown) => Promise<{ close: () => Promise<void> }> } }).chromium;
    if (!chromium || typeof chromium.launch !== "function") return false;
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

function makeCheck(id: string): Check {
  return {
    id,
    title: id,
    domain: "functional",
    persona: "functional",
    kind: "browser",
    intent: "verify evidence linkage",
    expected: "browser evidence, manifest, and report linkage are consistent",
    base_weight: 1,
    status: CheckStatus.PLANNED,
    weight: 1,
    actual: "",
    evidence: [],
    finding_ids: [],
    skip_reason: "",
    metadata: {},
  };
}

function minimalState(runId: string, checks: Check[], evidenceDir: string): RunStateDomain {
  return {
    schema_version: "1.0",
    run_id: runId,
    status: RunStatus.COMPLETED,
    workflow_id: "release-confidence",
    workflow_name: "Release Confidence",
    workflow_version: "1.0",
    started_at: "2026-11-15T00:00:00Z",
    updated_at: "2026-11-15T00:00:00Z",
    completed_at: "2026-11-15T00:00:10Z",
    target: { raw: "http://127.0.0.1/", kind: "url", resolved: "http://127.0.0.1/", source: "test" },
    intent: "verify browser linkage",
    personas: [],
    checks,
    findings: [],
    invalid_findings: [],
    blockers: [],
    risks: [],
    phases: [],
    confidence: normalizeConfidence({
      score: 80,
      band: "medium",
      coverage: 100,
      rationale: "linkage verification",
      limitations: [],
      penalties: {},
      domain_scores: {},
      breakdown: {},
      gate: { status: "warn" },
    }),
    kill_switch: { triggered: false, reason: "", stop_remaining: false },
    halted_reason: "",
    error: "",
    options: {},
    inventory: {},
    contract_failures: {},
    contract_failure_streaks: {},
    degraded_personas: [],
    evidence_dir: evidenceDir,
  } as unknown as RunStateDomain;
}

const workflow = {
  id: RELEASE_CONFIDENCE.id,
  name: RELEASE_CONFIDENCE.name,
  version: RELEASE_CONFIDENCE.version,
  phases: RELEASE_CONFIDENCE.phases.map((p) => ({ name: p.name, title: p.title, description: p.description })),
};

const playwrightAvailable = await canLaunchPlaywrightChromium();

describe("LEM-061 browser evidence, manifest, and report linkage", () => {
  it.skipIf(!playwrightAvailable)("links captured browser artifacts through manifest, check outcomes/state, and report", async () => {
    const srv = await serveDemoWeb();
    const root = await mkdtemp(join(tmpdir(), "lemma-browser-linkage-"));
    const runId = "run-browser-linkage";
    const evidence = new EvidenceStore(root, runId);
    await evidence.init();

    const checks = [
      makeCheck("browser.load"),
      makeCheck("browser.console"),
      makeCheck("browser.network"),
    ];
    const outcomes = new Map<string, CheckOutcome>();

    try {
      await runBrowserChecks({
        url: srv.url,
        checks,
        evidence,
        options: { headless: true },
        onOutcome: (check, outcome) => outcomes.set(check.id, outcome),
      });

      // Apply outcomes to checks/state (as orchestrator/outcomes layer does)
      const evidenceDir = `.lemma/evidence/${runId}`;
      const state = minimalState(runId, checks, evidenceDir);
      for (const check of checks) {
        const outcome = outcomes.get(check.id);
        expect(outcome, `missing outcome for ${check.id}`).toBeTruthy();
        recordCheckOutcome(state, check, outcome as CheckOutcome, null);
      }

      // Evidence refs produced and attached to check outcomes/state
      const load = checks.find((c) => c.id === "browser.load")!;
      expect(load.status).not.toBe(CheckStatus.BLOCKED);
      expect(load.evidence.length).toBeGreaterThan(0);

      // Browser artifacts saved in manifest
      const manifest = await evidence.finalize({ run_id: runId, status: "completed" });
      expect(manifest.evidence.length).toBeGreaterThan(0);
      const manifestPaths = new Set(manifest.evidence.map((e) => e.path));
      for (const ref of load.evidence) {
        expect(manifestPaths.has(ref), `manifest missing check evidence ref ${ref}`).toBe(true);
      }
      // Portable .lemma evidence paths and integrity metadata
      for (const entry of manifest.evidence) {
        expect(entry.path).toContain(`.lemma/evidence/${runId}/`);
        expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(entry.bytes).toBeGreaterThanOrEqual(0);
      }

      const verification = await evidence.verify();
      expect(verification.missing).toEqual([]);
      expect(verification.mismatches).toEqual([]);
      expect(verification.signature_valid).toBe(true);
      expect(verification.tampered).toBe(false);

      // Report linkage
      const report = buildReport(state, workflow, manifest.summary as unknown as Record<string, unknown>, "2026-11-15T00:00:10Z");
      const reportChecks = (report.checks as Array<{ id: string; evidence: string[] }>);
      const reportLoad = reportChecks.find((c) => c.id === "browser.load");
      expect(reportLoad).toBeTruthy();
      expect(reportLoad?.evidence ?? []).toEqual(load.evidence);
      for (const ref of reportLoad?.evidence ?? []) {
        expect(manifestPaths.has(ref)).toBe(true);
      }

      const reportEvidence = report.evidence as { directory: string; summary: { manifest?: string; count?: number } };
      expect(reportEvidence.directory).toBe(evidenceDir);
      expect(reportEvidence.summary.manifest).toBe(manifest.summary.manifest);
      expect(reportEvidence.summary.count).toBe(manifest.summary.count);

      // Every referenced browser evidence path in report checks resolves to manifest entry
      for (const check of reportChecks) {
        for (const ref of check.evidence ?? []) {
          if (ref.includes(`.lemma/evidence/${runId}/`)) {
            expect(manifestPaths.has(ref), `report ref not in manifest: ${ref}`).toBe(true);
          }
        }
      }
    } finally {
      await srv.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
