import path from "node:path";
import { randomUUID } from "node:crypto";

import { EvidenceStore } from "./evidence.js";
import { StateError } from "./errors.js";
import { atomicWriteJson, ensureDir } from "./state.js";
import { normalizeTarget, type Target } from "./models.js";
import { buildTestPlan, finalizeTestPlan, checksFromObservations } from "./test-plan.js";

export interface RunBrowserInspectionParams {
  target: Target | string | Record<string, unknown>;
  checks?: string[];
  scope?: Record<string, unknown>;
  runId?: string;
  root?: string;
  /** Internal/test hooks */
  options?: Record<string, unknown>;
  pageViews?: unknown[];
  pageView?: unknown;
}

export interface BrowserInspectionCommandResult {
  schema_version: "lemma.browser_inspection/v1";
  run_id: string;
  target: Record<string, unknown>;
  status: "completed" | "blocked";
  blocked: boolean;
  blocker?: Record<string, unknown>;
  scoped_checks: string[];
  observations: Array<Record<string, unknown>>;
  evidence_dir: string;
  evidence_manifest?: string;
  summary: Record<string, unknown>;
  /** Deterministic intent-specific plan created before execution and linked to results. */
  test_plan: ReturnType<typeof buildTestPlan>;
  deterministic: { fix_prompts: "check-derived" };
}

export async function runBrowserInspection(params: RunBrowserInspectionParams): Promise<BrowserInspectionCommandResult> {
  const root = params.root ?? process.cwd();
  const runId = params.runId ?? `browser-${randomUUID()}`;
  const target = normalizeTarget(params.target as any) as any;
  const evidence = new EvidenceStore(root, runId);
  await evidence.init();

  // Created in the Test Planning phase, before any browser runtime is started.
  const testPlan = buildTestPlan({
    intent: "Lemma browser assessment",
    target,
    inventory: (params.options?.sourceDir ? { root: String(params.options.sourceDir) } : {}) as Record<string, unknown>,
    command: "browser",
  });

  let browserMod: any;
  try {
    browserMod = await import("@lemma/browser");
  } catch (err) {
    // browser package unavailable -> blocked with explicit blocker, no fabricated screenshot
    const reason = `Browser inspection runtime unavailable: ${(err as Error)?.message || String(err)}`;
    const blocker = {
      id: `blocker:browser-runtime`,
      check_id: "browser.load",
      reason,
      boundary: "browser_runtime",
      unblock_evidence: ["Install/configure @lemma/browser and Playwright/Chromium, then rerun."],
    };
    const obs = (params.checks && params.checks.length ? params.checks : ["browser.load"]).map((id) => ({
      check_id: id,
      status: "blocked",
      actual: reason,
      evidence: { screenshot: null, console: null, network: null, refs: [] },
      fix_prompt: "Ensure @lemma/browser and a Playwright browser runtime are installed and available.",
      findings: [],
      blocked: true,
      blocker: { ...blocker, check_id: id, id: `blocker:${id}` },
      metadata: { blocked_by: "browser_runtime" },
    }));
    const result: BrowserInspectionCommandResult = {
      schema_version: "lemma.browser_inspection/v1",
      run_id: runId,
      target,
      status: "blocked",
      blocked: true,
      blocker,
      scoped_checks: obs.map((o) => o.check_id),
      observations: obs,
      evidence_dir: `.lemma/evidence/${runId}`,
      summary: { total: obs.length, passed: 0, failed: 0, blocked: obs.length, errored: 0 },
      test_plan: finalizeTestPlan(testPlan, checksFromObservations(obs)),
      deterministic: { fix_prompts: "check-derived" },
    };
    // persist durable inspection result under evidence/<run_id>/browser/
    const browserDir = path.join(root, ".lemma", "evidence", runId, "browser");
    await ensureDir(browserDir);
    await atomicWriteJson(path.join(browserDir, "inspection.json"), result);
    return result;
  }

  const runInspection = browserMod.runBrowserInspectionInBrowser as ((input: any) => Promise<any>) | undefined;
  if (typeof runInspection !== "function") {
    throw new StateError("Browser inspection is not available in @lemma/browser runtime");
  }

  const inspection = await runInspection({
    target,
    checks: params.checks,
    scope: params.scope,
    runId,
    options: { ...(params.options ?? {}), runId, root },
    evidence,
    pageViews: params.pageViews,
    pageView: params.pageView,
  });

  // persist durable evidence under .lemma/evidence/<run_id>/browser/
  const browserDir = path.join(root, ".lemma", "evidence", runId, "browser");
  await ensureDir(browserDir);
  const observations = Array.isArray(inspection?.observations)
    ? inspection.observations as Array<Record<string, unknown>>
    : [];
  const out: BrowserInspectionCommandResult = {
    ...inspection,
    run_id: runId,
    evidence_dir: `.lemma/evidence/${runId}/browser`,
    test_plan: finalizeTestPlan(testPlan, checksFromObservations(observations)),
  };
  await atomicWriteJson(path.join(browserDir, "inspection.json"), out);
  // also checkpoint evidence manifest if supported
  try { await (evidence as any).checkpoint?.(); } catch { /* best effort */ }

  return out;
}
