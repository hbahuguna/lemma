
import {
  CheckOutcome,
  CheckStatus,
  normalizeTarget,
  type Check,
  type FindingDraft,
  type Target,
} from "@lemma/core";

import {
  IMPLEMENTED_BROWSER_CHECKS,
  evaluateBrowserCheckForCheck,
  normalizePageView,
  type BrowserPageView,
} from "./checks.js";
import {
  BrowserUnavailableError,
  blockedBrowserOutcome,
  captureWithPlaywright,
  probeBrowserRuntime,
  type BrowserRuntimeOptions,
  type PlaywrightModuleLike,
} from "./runtime.js";

export interface BrowserInspectionEvidenceStore {
  saveJson(name: string, payload: unknown, kind?: string, description?: string, checkId?: string): Promise<string> | string;
  saveBytes?(name: string, data: Uint8Array | Buffer, kind?: string, description?: string, checkId?: string, suffix?: string): Promise<string> | string;
  saveScreenshot?(name: string, data: Uint8Array | Buffer, description?: string, checkId?: string): Promise<string> | string;
  readEvidenceArtifact?(relPath: string): Promise<{ data: Buffer; contentType: string } | null>;
}

export interface BrowserInspectionScope {
  /** Optional subset of page labels/urls/routes to include (best-effort match). */
  pages?: string[];
  /** Optional subset filter key; treated same as checks when provided. */
  only?: string[];
}

export interface BrowserInspectionInput {
  target: Target | string | Record<string, unknown>;
  checks?: string[];
  scope?: BrowserInspectionScope;
  runId?: string;
  options?: BrowserRuntimeOptions & {
    runId?: string;
    root?: string;
    evidenceDir?: string;
  };
  evidence?: BrowserInspectionEvidenceStore;
  /** Injectable page views for deterministic/testing runs. */
  pageViews?: BrowserPageView[] | Array<Record<string, unknown>>;
  pageView?: BrowserPageView | Record<string, unknown>;
}

export interface BrowserInspectionObservation {
  check_id: string;
  status: string;
  actual: string;
  evidence: {
    screenshot?: string | null;
    console?: string | null;
    network?: string | null;
    refs: string[];
  };
  fix_prompt?: string;
  findings: Array<FindingDraft & { fix_prompt?: string }>;
  blocked?: boolean;
  blocker?: { id: string; check_id: string; reason: string; boundary: string; unblock_evidence: string[] };
  metadata: Record<string, unknown>;
}

export interface BrowserInspectionResult {
  schema_version: "lemma.browser_inspection/v1";
  run_id: string;
  target: { raw: string; kind: string; resolved: string; [key: string]: unknown };
  status: "completed" | "blocked";
  blocked: boolean;
  blocker?: { id: string; check_id: string; reason: string; boundary: string; unblock_evidence: string[] };
  scoped_checks: string[];
  observations: BrowserInspectionObservation[];
  evidence_dir: string;
  summary: { total: number; passed: number; failed: number; blocked: number; errored: number };
  deterministic: { fix_prompts: "check-derived" };
}

const FIX_PROMPTS: Record<string, string> = {
  "browser.load": "Ensure the target URL is reachable, returns a successful status, and renders visible page content without navigation errors.",
  "browser.console": "Resolve browser console errors and uncaught page exceptions shown in the console transcript.",
  "browser.network": "Fix failed or erroring network requests and ensure critical assets/API calls complete successfully.",
  "browser.content": "Provide clear, meaningful page content and required metadata so the page is readable and correctly identified.",
  "browser.links": "Repair broken, unsafe, or invalid links and ensure destinations/attributes are correct.",
  "browser.security": "Address reported browser-observable security issues (headers, mixed content, insecure exposure) for the inspected page.",
  "browser.accessibility": "Fix accessibility issues identified for the inspected page (semantics, labels, contrast/focus/structure as reported).",
  "browser.overflow": "Adjust layout/CSS so content does not overflow the viewport at the inspected size.",
  "browser.focus_order": "Ensure interactive elements follow a logical, visible keyboard focus order.",
  "browser.steps": "Update the scenario steps/selectors or page behavior so the scripted flow completes as expected.",
};

export function deterministicFixPrompt(checkId: string): string {
  return FIX_PROMPTS[checkId] ?? `Review evidence for ${checkId} and remediate the reported issue deterministically based on the observation.`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(Boolean);
}

function scopedCheckIds(all: Check[], checks?: string[], scope?: BrowserInspectionScope): Check[] {
  const scopeAny = scope as any;
  const explicit = new Set([
    ...(checks ?? []),
    ...normalizeStringArray(scopeAny?.checks),
    ...normalizeStringArray(scopeAny?.checkIds),
    ...normalizeStringArray(scope?.only),
  ]);
  if (explicit.size === 0) return all;
  return all.filter((c) => explicit.has(c.id));
}

function defaultBrowserChecks(url: string): Check[] {
  // minimal scoped inspection set; runtime/evaluator will block unsupported/unevaluable cases explicitly
  const ids = [
    "browser.load",
    "browser.console",
    "browser.network",
    "browser.content",
    "browser.links",
  ];
  return ids.map((id) => ({
    id,
    title: id,
    domain: "functional",
    kind: "browser",
    intent: "Focused browser inspection",
    expected: "Observable browser behavior captured with evidence",
    requires: "url",
    persona: "",
    status: "planned",
    evidence: [],
    finding_ids: [],
    metadata: { url },
  } as unknown as Check));
}

function pickObservationEvidence(view: BrowserPageView | null, outcome: CheckOutcome): BrowserInspectionObservation["evidence"] {
  const refs = Array.isArray(outcome.evidence) ? outcome.evidence.filter((x): x is string => typeof x === "string") : [];
  const viewRefs = view?.evidenceRefs ?? {};
  const screenshot = (typeof viewRefs.screenshot === "string" && viewRefs.screenshot) ? viewRefs.screenshot : (refs.find((r) => /screenshot|\.png$|\.jpg$|\.jpeg$|\.webp$/i.test(r)) ?? null);
  const consoleRef = (typeof viewRefs.console === "string" && viewRefs.console) ? viewRefs.console : (refs.find((r) => /console/i.test(r)) ?? null);
  const networkRef = (typeof viewRefs.network === "string" && viewRefs.network) ? viewRefs.network : (refs.find((r) => /network|har/i.test(r)) ?? null);
  return { screenshot, console: consoleRef, network: networkRef, refs };
}

function toObservation(check: Check, outcome: CheckOutcome, view: BrowserPageView | null, blockedReason?: string): BrowserInspectionObservation {
  const fix = deterministicFixPrompt(check.id);
  const findings = (Array.isArray(outcome.findings) ? outcome.findings : []).map((f) => ({ ...(f as any), fix_prompt: fix }));
  const blocked = outcome.status === CheckStatus.BLOCKED || outcome.status === "blocked";
  const blocker = blocked
    ? {
        id: `blocker:${check.id}`,
        check_id: check.id,
        reason: blockedReason || outcome.actual || "Browser inspection blocked",
        boundary: "browser_runtime",
        unblock_evidence: ["Provide an available browser runtime (Playwright/Chromium) or run without --no-browser."],
      }
    : undefined;
  return {
    check_id: check.id,
    status: String(outcome.status),
    actual: String(outcome.actual ?? ""),
    evidence: pickObservationEvidence(view, outcome),
    fix_prompt: fix,
    findings,
    ...(blocked ? { blocked: true } : {}),
    ...(blocker ? { blocker } : {}),
    metadata: { ...(outcome.metadata ?? {}), fix_prompt: fix },
  };
}

export async function runBrowserInspectionInBrowser(input: BrowserInspectionInput): Promise<BrowserInspectionResult> {
  const runId = input.runId ?? String((input.options as any)?.runId || `browser-inspection-${Date.now()}`);
  const target = normalizeTarget(input.target as any);
  const url = target.resolved || target.raw;
  const evidenceDir = (input.options as any)?.evidenceDir
    ? String((input.options as any).evidenceDir)
    : `.lemma/evidence/${runId}/browser`;
  const allChecks = defaultBrowserChecks(url);
  const selected = scopedCheckIds(allChecks, input.checks, input.scope);
  const scopedChecks = selected.map((c) => c.id);

  const options = input.options ?? {};
  const probe = await probeBrowserRuntime(options);
  if (!probe.available || !probe.playwright) {
    const reason = probe.reason ?? "Browser runtime is unavailable.";
    const observations = selected.map((check) => {
      const outcome = blockedBrowserOutcome(check, reason);
      // no fabricated screenshot: ensure no screenshot ref
      if (Array.isArray(outcome.evidence)) {
        outcome.evidence = outcome.evidence.filter((r) => !/screenshot|\.png$|\.jpg$|\.jpeg$|\.webp$/i.test(String(r)));
      }
      return toObservation(check, outcome, null, reason);
    });
    const blocker = observations[0]?.blocker ?? {
      id: `blocker:browser-runtime`,
      check_id: selected[0]?.id ?? "browser.load",
      reason,
      boundary: "browser_runtime",
      unblock_evidence: ["Provide an available browser runtime (Playwright/Chromium) or run without --no-browser."],
    };
    return {
      schema_version: "lemma.browser_inspection/v1",
      run_id: runId,
      target: target as any,
      status: "blocked",
      blocked: true,
      blocker,
      scoped_checks: scopedChecks,
      observations,
      evidence_dir: evidenceDir,
      summary: { total: observations.length, passed: 0, failed: 0, blocked: observations.length, errored: 0 },
      deterministic: { fix_prompts: "check-derived" },
    };
  }

  let views: BrowserPageView[] = [];
  if (Array.isArray(input.pageViews) && input.pageViews.length > 0) {
    views = input.pageViews.map(normalizePageView);
  } else if (input.pageView) {
    views = [normalizePageView(input.pageView)];
  } else {
    try {
      views = await captureWithPlaywright(url, probe.playwright as PlaywrightModuleLike, options, input.evidence as any);
    } catch (err) {
      const reason = err instanceof BrowserUnavailableError ? err.reason : (err instanceof Error ? err.message : String(err));
      const observations = selected.map((check) => toObservation(check, blockedBrowserOutcome(check, reason), null, reason));
      const blocker = observations[0]?.blocker;
      return {
        schema_version: "lemma.browser_inspection/v1",
        run_id: runId,
        target: target as any,
        status: "blocked",
        blocked: true,
        ...(blocker ? { blocker } : {}),
        scoped_checks: scopedChecks,
        observations,
        evidence_dir: evidenceDir,
        summary: { total: observations.length, passed: 0, failed: 0, blocked: observations.length, errored: 0 },
        deterministic: { fix_prompts: "check-derived" },
      };
    }
  }

  const primary = views[0] ?? null;
  const observations: BrowserInspectionObservation[] = [];
  for (const check of selected) {
    if (!IMPLEMENTED_BROWSER_CHECKS.has(check.id)) {
      const out = blockedBrowserOutcome(check, `Browser check ${check.id} is not implemented in this runtime.`);
      observations.push(toObservation(check, out, primary));
      continue;
    }
    const out = primary
      ? evaluateBrowserCheckForCheck(check, primary)
      : blockedBrowserOutcome(check, "No browser page view could be captured.");
    // ensure observation references include screenshot/console/network when captured
    observations.push(toObservation(check, out, primary));
  }

  const summary = observations.reduce(
    (acc, o) => {
      acc.total += 1;
      if (o.status === "passed") acc.passed += 1;
      else if (o.status === "failed") acc.failed += 1;
      else if (o.status === "blocked") acc.blocked += 1;
      else if (o.status === "error" || o.status === "errored") acc.errored += 1;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, blocked: 0, errored: 0 },
  );
  const anyBlocked = summary.blocked > 0 && summary.failed === 0 && summary.passed === 0;

  return {
    schema_version: "lemma.browser_inspection/v1",
    run_id: runId,
    target: target as any,
    status: anyBlocked ? "blocked" : "completed",
    blocked: anyBlocked,
    ...((() => { const b = observations.find((o) => o.blocker)?.blocker; return b ? { blocker: b } : {}; })()),
    scoped_checks: scopedChecks,
    observations,
    evidence_dir: evidenceDir,
    summary,
    deterministic: { fix_prompts: "check-derived" },
  };
}
