import { CheckOutcome, CheckStatus, type Check } from "./models.js";

export const BROWSER_ADAPTER_SCHEMA_VERSION = "lemma.browser_adapter/v1" as const;

export type BrowserChannel = "navigation" | "screenshots" | "console" | "network" | "storage" | "viewport" | "crawl";

export interface BrowserAdapterCapabilities {
  navigation: boolean;
  screenshots: boolean;
  console: boolean;
  network: boolean;
  storage: boolean;
  viewport: boolean;
  crawl: boolean;
}

export interface BrowserAdapterDescriptor {
  schema_version: typeof BROWSER_ADAPTER_SCHEMA_VERSION;
  adapter_id: string;
  adapter_version: string;
  native_version?: string | null;
  capabilities: BrowserAdapterCapabilities;
}

export interface BrowserDispatchRequest {
  url: string;
  checks: readonly Check[];
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BrowserDispatchResult {
  outcomes: Map<string, CheckOutcome> | Record<string, CheckOutcome>;
  coverage_notes?: string[];
  blocked_runtime?: boolean;
  blocked_reason?: string;
  [key: string]: unknown;
}

/**
 * Host-neutral browser adapter contract (LEM-191).
 * Adapters declare capabilities and are negotiated before dispatch.
 */
export interface BrowserAdapter {
  readonly id: string;
  readonly version: string;
  readonly nativeVersion?: string | null;
  capabilities(): BrowserAdapterCapabilities | Promise<BrowserAdapterCapabilities>;
  /** Optional probe; if unavailable, dispatch may be re-planned/blocked without fabricated pass. */
  probe?(options?: Record<string, unknown>): Promise<{ available: boolean; reason?: string }> | { available: boolean; reason?: string };
  dispatch(request: BrowserDispatchRequest): Promise<BrowserDispatchResult>;
}

export const BROWSER_CHECK_REQUIRED_CHANNELS: Record<string, BrowserChannel[]> = {
  "browser.load": ["navigation"],
  "browser.console": ["console"],
  "browser.network": ["network"],
  "browser.content": ["navigation"],
  "browser.links": ["navigation"],
  "browser.security": ["navigation"],
  "browser.accessibility": ["navigation"],
  "browser.overflow": ["navigation", "viewport"],
  "browser.focus_order": ["navigation"],
  "browser.steps": ["navigation"],
  // crawl-dependent behavior handled via request options; checks may still run on seed but crawl requires crawl capability
};

export function requiredChannelsForBrowserCheck(check: Check | { id: string }, options?: Record<string, unknown>): BrowserChannel[] {
  const id = typeof (check as any)?.id === "string" ? (check as any).id : "";
  const base = [...(BROWSER_CHECK_REQUIRED_CHANNELS[id] ?? ["navigation"])];
  const wantsCrawl = options?.crawl === true || options?.maxPages != null || options?.max_pages != null;
  if (wantsCrawl && !base.includes("crawl")) base.push("crawl");
  // screenshot evidence capture is desirable but not a hard requirement for most checks; treat as optional unless explicitly requested
  if ((options?.screenshot === true || options?.captureScreenshot === true) && !base.includes("screenshots")) base.push("screenshots");
  if ((options?.storageState != null || options?.storage_state != null) && !base.includes("storage")) base.push("storage");
  return Array.from(new Set(base));
}

export function missingChannelsForCapabilities(required: readonly BrowserChannel[], capabilities: BrowserAdapterCapabilities): BrowserChannel[] {
  return required.filter((ch) => capabilities[ch] !== true);
}

export interface BrowserNegotiationPlanItem {
  check_id: string;
  action: "dispatch" | "replan_skip";
  missing_channels: BrowserChannel[];
  coverage_note?: string;
}

export interface BrowserNegotiationResult {
  adapter: BrowserAdapterDescriptor;
  plan: BrowserNegotiationPlanItem[];
  dispatch_checks: string[];
  replanned_checks: string[];
  coverage_notes: string[];
}

export function describeAdapter(adapter: BrowserAdapter, capabilities: BrowserAdapterCapabilities, nativeVersion?: string | null): BrowserAdapterDescriptor {
  return {
    schema_version: BROWSER_ADAPTER_SCHEMA_VERSION,
    adapter_id: adapter.id,
    adapter_version: adapter.version,
    native_version: nativeVersion ?? adapter.nativeVersion ?? null,
    capabilities: { ...capabilities },
  };
}

export function negotiateBrowserDispatch(
  adapter: BrowserAdapter,
  capabilities: BrowserAdapterCapabilities,
  checks: readonly Check[],
  options?: Record<string, unknown>,
): BrowserNegotiationResult {
  const descriptor = describeAdapter(adapter, capabilities, (adapter as any).nativeVersion ?? null);
  const plan: BrowserNegotiationPlanItem[] = [];
  const dispatchChecks: string[] = [];
  const replanned: string[] = [];
  const coverageNotes: string[] = [];

  for (const check of checks) {
    const required = requiredChannelsForBrowserCheck(check, options);
    const missing = missingChannelsForCapabilities(required, capabilities);
    if (missing.length > 0) {
      const note = `Re-planned: browser check '${check.id}' skipped because adapter '${descriptor.adapter_id}' is missing required channel(s): ${missing.join(", ")}. Explicit coverage gap recorded (not a pass).`;
      plan.push({ check_id: check.id, action: "replan_skip", missing_channels: missing, coverage_note: note });
      replanned.push(check.id);
      coverageNotes.push(note);
    } else {
      plan.push({ check_id: check.id, action: "dispatch", missing_channels: [] });
      dispatchChecks.push(check.id);
    }
  }

  return { adapter: descriptor, plan, dispatch_checks: dispatchChecks, replanned_checks: replanned, coverage_notes: coverageNotes };
}

function makeSkippedOutcome(_check: Check, note: string, missing: BrowserChannel[], adapterId: string): CheckOutcome {
  return new CheckOutcome({
    status: CheckStatus.SKIPPED,
    actual: note,
    evidence: [],
    findings: [],
    blocker: null,
    metadata: {
      limitation: note,
      coverage_note: note,
      replanned: true,
      missing_channels: missing,
      adapter_id: adapterId,
      not_a_pass: true,
    },
  });
}

export async function dispatchWithBrowserAdapter(
  adapter: BrowserAdapter,
  request: BrowserDispatchRequest,
): Promise<{ result: BrowserNegotiationResult; outcomes: Map<string, CheckOutcome>; coverage_notes: string[] }> {
  const capabilities = await Promise.resolve(adapter.capabilities());
  const negotiation = negotiateBrowserDispatch(adapter, capabilities, request.checks, request.options);

  const outcomes = new Map<string, CheckOutcome>();
  for (const item of negotiation.plan) {
    if (item.action === "replan_skip") {
      const check = request.checks.find((c) => c.id === item.check_id);
      if (check) outcomes.set(check.id, makeSkippedOutcome(check, item.coverage_note || "Re-planned due to missing adapter channel.", item.missing_channels, negotiation.adapter.adapter_id));
    }
  }

  if (negotiation.dispatch_checks.length > 0) {
    const dispatchChecks = request.checks.filter((c) => negotiation.dispatch_checks.includes(c.id));
    const res = await adapter.dispatch({ ...request, checks: dispatchChecks });
    const resOutcomes = res.outcomes instanceof Map ? res.outcomes : new Map(Object.entries(res.outcomes || {}));
    for (const [id, outcome] of resOutcomes.entries()) outcomes.set(id, outcome as CheckOutcome);
    for (const note of res.coverage_notes || []) negotiation.coverage_notes.push(note);
  }

  // ensure every requested check has an outcome (no silent drop)
  for (const check of request.checks) {
    if (!outcomes.has(check.id)) {
      const note = `Browser check '${check.id}' was not produced by adapter dispatch; recorded as skipped with explicit coverage gap (not a pass).`;
      outcomes.set(check.id, makeSkippedOutcome(check, note, [], negotiation.adapter.adapter_id));
      negotiation.coverage_notes.push(note);
    }
  }

  return { result: negotiation, outcomes, coverage_notes: negotiation.coverage_notes };
}
