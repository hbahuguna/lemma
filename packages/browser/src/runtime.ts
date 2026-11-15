import { readFileSync } from "node:fs";

import {
  CheckOutcome,
  CheckStatus,
  type BlockerDraft,
  type Check,
} from "@lemma/core";

import {
  IMPLEMENTED_BROWSER_CHECKS,
  discoverRoutes,
  evaluateBrowserCheckAcrossViews,
  evaluateBrowserCheckForCheck,
  normalizePageView,
  routeLabel,
  type BrowserPageView,
} from "./checks.js";

export interface PlaywrightModuleLike {
  chromium?: {
    launch?: (options?: Record<string, unknown>) => Promise<unknown>;
  };
  [key: string]: unknown;
}

export interface BrowserRuntimeOptions {
  /** Disable browser execution and degrade all browser checks as blocked. */
  noBrowser?: boolean;
  /** Alias for noBrowser. */
  disabled?: boolean;
  headless?: boolean;
  timeoutMs?: number;
  /** Enable bounded same-origin crawl (LEM-054). */
  crawl?: boolean;
  /** Maximum pages to capture/evaluate when crawling (seed included). */
  maxPages?: number;
  /** Alias for maxPages. */
  max_pages?: number;
  /**
   * Authenticated Playwright storage state: file path, `env:VAR`, or resolved
   * state object (LEM-056). Resolved/injected state must not be persisted.
   */
  storageState?: string | Record<string, unknown>;
  /** Alias for storageState. */
  storage_state?: string | Record<string, unknown>;
  /**
   * Test/extension hook: provide a custom Playwright loader. Returning/throwing
   * an unavailable module simulates a missing runtime.
   */
  playwrightLoader?: () => Promise<PlaywrightModuleLike>;
  /**
   * Test/extension hook: validate that a loaded runtime is usable (e.g. launch
   * Chromium). Throw to mark unavailable.
   */
  runtimeValidator?: (playwright: PlaywrightModuleLike) => Promise<void> | void;
}

export interface BrowserProbeResult {
  available: boolean;
  reason?: string;
  playwright?: PlaywrightModuleLike;
}

export class BrowserUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "BrowserUnavailableError";
    this.reason = reason;
  }
}

export type BrowserStorageStateInput = string | Record<string, unknown>;

/**
 * Resolve and validate authenticated browser storage state (LEM-056).
 * Accepts a file path, `env:VAR` reference, or already-resolved state object.
 * Throws BrowserUnavailableError with assay-compatible boundaries on invalid
 * input. Returned state must not be persisted to evidence/logs/outcomes.
 */
export function resolveBrowserStorageState(value: BrowserStorageStateInput): Record<string, unknown> {
  if (value && typeof value === "object") {
    validateBrowserStorageState(value);
    return value;
  }

  let raw: string | undefined;
  if (typeof value === "string" && value.startsWith("env:")) {
    const variable = value.slice(4);
    raw = process.env[variable];
    if (raw === undefined) {
      throw new BrowserUnavailableError(
        `Storage state environment variable '${variable}' is not set.`,
      );
    }
  } else if (typeof value === "string") {
    try {
      raw = readFileSync(value, "utf8");
    } catch {
      throw new BrowserUnavailableError(`Storage state file was not found: ${value}`);
    }
  } else {
    throw new BrowserUnavailableError("Storage state is not valid JSON.");
  }

  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new BrowserUnavailableError("Storage state is not valid JSON.");
  }

  validateBrowserStorageState(state);
  return state;
}

function validateBrowserStorageState(state: unknown): asserts state is Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new BrowserUnavailableError("Storage state must be a JSON object.");
  }
  const obj = state as Record<string, unknown>;
  const cookies = obj.cookies;
  const origins = obj.origins;
  if (!Array.isArray(cookies) || !Array.isArray(origins)) {
    throw new BrowserUnavailableError("Storage state cookies and origins must be arrays.");
  }

  const now = Date.now() / 1000;
  let hasValidCookie = false;
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) {
      throw new BrowserUnavailableError("Storage state contains an invalid cookie entry.");
    }
    const expires = (cookie as Record<string, unknown>).expires;
    if (expires === undefined || expires === null || expires === 0 || expires === -1) {
      hasValidCookie = true;
    } else if (typeof expires === "number" && Number.isFinite(expires)) {
      if (expires > now) hasValidCookie = true;
    }
  }

  if (cookies.length > 0 && !hasValidCookie && origins.length === 0) {
    throw new BrowserUnavailableError(
      "Storage state has expired; provide a fresh state file or secret.",
    );
  }
  if (cookies.length === 0 && origins.length === 0) {
    throw new BrowserUnavailableError("Storage state is empty.");
  }
}

const DEFAULT_INSTALL_HINT =
  "Install Playwright and Chromium (for example: `pnpm add -D playwright` and `pnpm exec playwright install chromium`), then rerun the check.";

export function browserDisabledReason(options?: BrowserRuntimeOptions): string | null {
  if (options?.noBrowser || options?.disabled) {
    return "Browser execution is disabled (--no-browser).";
  }
  return null;
}

export async function loadPlaywright(
  options?: BrowserRuntimeOptions,
): Promise<PlaywrightModuleLike> {
  const loader =
    options?.playwrightLoader ??
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- playwright module typing varies by install; cast for runtime probe contract
    (async () => (await import("playwright")) as PlaywrightModuleLike);
  try {
    const mod = await loader();
    if (!mod || typeof mod !== "object") {
      throw new BrowserUnavailableError("Playwright module could not be loaded.");
    }
    if (options?.runtimeValidator) {
      await options.runtimeValidator(mod);
    }
    return mod;
  } catch (error) {
    if (error instanceof BrowserUnavailableError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new BrowserUnavailableError(
      `Playwright/Chromium runtime is unavailable: ${detail}`,
    );
  }
}

export async function probeBrowserRuntime(
  options?: BrowserRuntimeOptions,
): Promise<BrowserProbeResult> {
  const disabled = browserDisabledReason(options);
  if (disabled) {
    return { available: false, reason: disabled };
  }
  try {
    const playwright = await loadPlaywright(options);
    return { available: true, playwright };
  } catch (error) {
    const reason =
      error instanceof BrowserUnavailableError
        ? error.reason
        : error instanceof Error
          ? error.message
          : String(error);
    return { available: false, reason };
  }
}

function blockerDraftForUnavailable(check: Check, reason: string): BlockerDraft {
  const boundary = reason.includes("Browser execution")
    ? reason
    : `Browser execution is unavailable: ${reason}`;
  return {
    attempted_action: check.title || check.id,
    boundary,
    unblock_evidence: [
      DEFAULT_INSTALL_HINT,
      `Provide a runnable browser target and a Playwright/Chromium installation, then rerun check '${check.id}'.`,
    ],
    covered_elsewhere: false,
    covered_by: [],
  };
}

export function blockedBrowserOutcome(check: Check, reason: string): CheckOutcome {
  return new CheckOutcome({
    status: CheckStatus.BLOCKED,
    actual: `Browser checks were not executed: ${reason}`,
    evidence: [],
    findings: [],
    blocker: blockerDraftForUnavailable(check, reason),
    metadata: {
      limitation: reason,
      blocked_by: "browser_runtime",
    },
  });
}

function notImplementedOutcome(check: Check): CheckOutcome {
  const reason = `Browser check '${check.id}' is not implemented in this runtime slice.`;
  return new CheckOutcome({
    status: CheckStatus.BLOCKED,
    actual: reason,
    evidence: [],
    findings: [],
    blocker: {
      attempted_action: check.title || check.id,
      boundary: reason,
      unblock_evidence: [
        `Run check '${check.id}' with a browser runtime slice that implements it, or exclude it from this run.`,
      ],
      covered_elsewhere: false,
      covered_by: [],
    },
    metadata: {
      limitation: reason,
      blocked_by: "browser_runtime",
      not_implemented: true,
    },
  });
}

export type BrowserOutcomeCallback = (
  check: Check,
  outcome: CheckOutcome,
) => unknown;

export interface BrowserEvidenceStoreLike {
  saveJson(
    name: string,
    payload: unknown,
    kind?: string,
    description?: string,
    checkId?: string,
  ): Promise<string> | string;
  saveScreenshot?(
    name: string,
    data: Uint8Array | Buffer,
    description?: string,
    checkId?: string,
  ): Promise<string> | string;
}

export interface RunBrowserChecksInput {
  url: string;
  checks: readonly Check[];
  onOutcome: BrowserOutcomeCallback;
  options?: BrowserRuntimeOptions;
  /** Injected captured observations for deterministic evaluation/testing. */
  pageView?: BrowserPageView | Record<string, unknown>;
  /** Injected captured observations for crawl/multi-route evaluation/testing. */
  pageViews?: ReadonlyArray<BrowserPageView | Record<string, unknown>>;
  /** Alias for pageViews. */
  views?: ReadonlyArray<BrowserPageView | Record<string, unknown>>;
  /** Optional evidence store for Playwright capture paths. */
  evidence?: BrowserEvidenceStoreLike;
}

/**
 * Emit blocked outcomes for every browser check without throwing.
 */
export async function degradeBrowserChecks(
  checks: readonly Check[],
  reason: string,
  onOutcome: BrowserOutcomeCallback,
): Promise<void> {
  for (const check of checks) {
    await onOutcome(check, blockedBrowserOutcome(check, reason));
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Playwright is an optional untyped runtime dependency; interop uses dynamic APIs */

function getMaxPages(options?: BrowserRuntimeOptions): number {
  const raw = options?.maxPages ?? options?.max_pages ?? 1;
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

async function captureSinglePage(
  page: any,
  url: string,
  options: BrowserRuntimeOptions | undefined,
  evidence: BrowserEvidenceStoreLike | undefined,
  label: string,
): Promise<BrowserPageView> {
  const timeoutMs = options?.timeoutMs ?? 30000;
  const consoleMessages: Array<Record<string, unknown>> = [];
  const pageErrors: Array<Record<string, unknown>> = [];
  const networkEntries: Array<Record<string, unknown>> = [];
  const navigation: { url: string; finalUrl: string; status?: number | null; headers?: Record<string, string>; error?: string } = {
    url,
    finalUrl: url,
  };
  const evidenceRefs: Record<string, string> = {};

  const onConsole = (msg: any) => {
    try {
      consoleMessages.push({ type: msg.type?.() ?? "log", text: String(msg.text?.() ?? "") });
    } catch {
      // ignore console capture errors
    }
  };
  const onPageError = (err: any) => {
    pageErrors.push({ text: String(err?.message ?? err ?? "page error") });
  };
  const onRequestFailed = (req: any) => {
    try {
      networkEntries.push({
        url: String(req.url?.() ?? ""),
        method: String(req.method?.() ?? "GET"),
        failed: true,
        failure: String(req.failure?.()?.errorText ?? req.failure?.() ?? "request failed"),
      });
    } catch {
      // ignore
    }
  };
  const onResponse = (res: any) => {
    try {
      networkEntries.push({
        url: String(res.url?.() ?? ""),
        status: typeof res.status === "function" ? res.status() : undefined,
        failed: false,
      });
    } catch {
      // ignore
    }
  };

  page.on?.("console", onConsole);
  page.on?.("pageerror", onPageError);
  page.on?.("requestfailed", onRequestFailed);
  page.on?.("response", onResponse);

  try {
    let response: any = null;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      navigation.status = typeof response?.status === "function" ? response.status() : null;
      navigation.finalUrl = typeof page.url === "function" ? page.url() : url;
      try {
        const headers = typeof response?.headers === "function" ? await response.headers() : {};
        const normalized: Record<string, string> = {};
        if (headers && typeof headers === "object") {
          for (const [k, v] of Object.entries(headers)) normalized[String(k).toLowerCase()] = String(v);
        }
        navigation.headers = normalized;
      } catch {
        navigation.headers = {};
      }
    } catch (error) {
      navigation.error = error instanceof Error ? error.message : String(error);
      try {
        navigation.finalUrl = typeof page.url === "function" ? page.url() : url;
      } catch {
        navigation.finalUrl = url;
      }
    }

    let snapshot: Record<string, unknown> = {};
    try {
      if (!navigation.error && typeof page.evaluate === "function") {
        snapshot = await page.evaluate(() => {
          const doc = (globalThis as any).document;
          const bodyText = doc?.body?.innerText ?? doc?.body?.textContent ?? "";
          const h1s = Array.from(doc?.querySelectorAll?.("h1") ?? [])
            .map((n: any) => String(n?.innerText ?? n?.textContent ?? "").trim())
            .filter((t: string) => t.length > 0);
          const links = Array.from(doc?.querySelectorAll?.("a") ?? []).map((a: any, i: number) => ({
            selector: `a:nth-of-type(${i + 1})`,
            href: String(a?.getAttribute?.("href") ?? ""),
            target: String(a?.getAttribute?.("target") ?? ""),
            rel: String(a?.getAttribute?.("rel") ?? ""),
            download: a?.hasAttribute?.("download") ? true : false,
          }));
          return {
            title: String(doc?.title ?? ""),
            bodyTextLength: String(bodyText).trim().length,
            h1s,
            links,
          };
        });
      }
    } catch {
      snapshot = {};
    }

    const prefix = label === "landing" ? "" : `${label}-`;
    const shotName = label === "landing" ? "landing-page" : `${label}-page`;
    if (evidence) {
      try {
        evidenceRefs.navigation = await evidence.saveJson(
          `${prefix}navigation`,
          navigation,
          "navigation",
          label === "landing" ? "Browser navigation result" : `Navigation result for ${label}`,
        );
        evidenceRefs.snapshot = await evidence.saveJson(
          `${prefix}dom-snapshot`,
          snapshot,
          "dom_snapshot",
          label === "landing" ? "Captured DOM snapshot" : `Sanitized DOM snapshot for ${label}`,
        );
        evidenceRefs.console = await evidence.saveJson(
          `${prefix}console-log`,
          [...consoleMessages, ...pageErrors.map((e) => ({ type: "pageerror", ...e }))],
          "console_log",
          label === "landing" ? "Browser console and page errors" : `Console log for ${label}`,
        );
        evidenceRefs.network = await evidence.saveJson(
          `${prefix}network-log`,
          networkEntries,
          "network_log",
          label === "landing" ? "Browser network entries" : `Network log for ${label}`,
        );
      } catch {
        // evidence capture must not fail the check run
      }
      try {
        if (typeof page.screenshot === "function" && evidence.saveScreenshot) {
          const shot = await page.screenshot({ fullPage: true });
          if (shot) {
            evidenceRefs.screenshot = await evidence.saveScreenshot(
              shotName,
              shot as Uint8Array | Buffer,
              label === "landing" ? "Landing page screenshot" : `Screenshot for ${label}`,
            );
          }
        }
      } catch {
        // screenshot is best-effort
      }
    }

    return normalizePageView({
      navigation,
      snapshot,
      consoleMessages,
      pageErrors,
      networkEntries,
      evidenceRefs,
      label,
    });
  } finally {
    // remove listeners when page API supports it to avoid cross-page bleed in crawl
    try { page.off?.("console", onConsole); } catch { /* noop */ }
    try { page.off?.("pageerror", onPageError); } catch { /* noop */ }
    try { page.off?.("requestfailed", onRequestFailed); } catch { /* noop */ }
    try { page.off?.("response", onResponse); } catch { /* noop */ }
  }
}

async function captureWithPlaywright(
  url: string,
  playwright: PlaywrightModuleLike,
  options: BrowserRuntimeOptions | undefined,
  evidence?: BrowserEvidenceStoreLike,
): Promise<BrowserPageView[]> {
  const chromium = playwright.chromium;
  if (!chromium || typeof chromium.launch !== "function") {
    throw new BrowserUnavailableError("Playwright Chromium launcher is unavailable.");
  }
  const headless = options?.headless ?? true;
  const storageStateInput = options?.storageState ?? options?.storage_state;
  const resolvedStorageState =
    storageStateInput !== undefined ? resolveBrowserStorageState(storageStateInput) : undefined;

  const browser = (await chromium.launch({ headless })) as {
    newContext: (opts?: Record<string, unknown>) => Promise<{
      newPage: () => Promise<any>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  };
  const contextOptions: Record<string, unknown> = { viewport: { width: 1280, height: 720 } };
  if (resolvedStorageState) {
    contextOptions.storageState = resolvedStorageState;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const views: BrowserPageView[] = [];
  try {
    const seedView = await captureSinglePage(page, url, options, evidence, "landing");
    views.push(seedView);

    const crawl = options?.crawl === true;
    const maxPages = getMaxPages(options);
    if (crawl && maxPages > 1) {
      const discovered = discoverRoutes(
        seedView.navigation.finalUrl || seedView.navigation.url || url,
        seedView.snapshot ?? {},
        maxPages,
      );
      for (let i = 0; i < discovered.length; i++) {
        const routeUrl = discovered[i]!;
        const label = routeLabel(routeUrl, i + 1);
        try {
          const view = await captureSinglePage(page, routeUrl, options, evidence, label);
          views.push(view);
        } catch {
          // route capture failures are represented as navigation-failed views by captureSinglePage;
          // defensive: never let one route crash the crawl.
        }
      }
    }
    return views;
  } finally {
    try { await context.close(); } catch { /* noop */ }
    try { await browser.close(); } catch { /* noop */ }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

/**
 * Run browser checks with optional runtime. If runtime is unavailable/disabled
 * or the check is outside this runtime slice, blocked outcomes are emitted.
 * When crawl is enabled and injected multi-view observations are provided (or
 * Playwright capture succeeds), implemented checks are evaluated across routes
 * and merged (LEM-054).
 */
export async function runBrowserChecks(
  input: RunBrowserChecksInput,
): Promise<void> {
  const { checks, onOutcome, options, evidence } = input;
  const probe = await probeBrowserRuntime(options);
  if (!probe.available || !probe.playwright) {
    const reason = probe.reason ?? "Browser runtime is unavailable.";
    await degradeBrowserChecks(checks, reason, onOutcome);
    return;
  }

  let views: BrowserPageView[] | null = null;
  if (Array.isArray(input.pageViews) && input.pageViews.length > 0) {
    views = input.pageViews.map(normalizePageView);
  } else if (Array.isArray(input.views) && input.views.length > 0) {
    views = input.views.map(normalizePageView);
  } else if (input.pageView) {
    views = [normalizePageView(input.pageView)];
  } else {
    try {
      views = await captureWithPlaywright(input.url, probe.playwright, options, evidence);
    } catch (error) {
      const reason =
        error instanceof BrowserUnavailableError
          ? error.reason
          : error instanceof Error
            ? error.message
            : String(error);
      await degradeBrowserChecks(checks, reason, onOutcome);
      return;
    }
  }

  if (!views || views.length === 0) {
    await degradeBrowserChecks(checks, "No browser page view could be captured.", onOutcome);
    return;
  }

  const multi = views.length > 1 || (options?.crawl === true && getMaxPages(options) > 1);

  for (const check of checks) {
    try {
      if (!IMPLEMENTED_BROWSER_CHECKS.has(check.id)) {
        await onOutcome(check, notImplementedOutcome(check));
        continue;
      }
      const outcome = multi
        ? evaluateBrowserCheckAcrossViews(check, views)
        : evaluateBrowserCheckForCheck(check, views[0]!);
      await onOutcome(check, outcome);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await onOutcome(check, blockedBrowserOutcome(check, `Browser check execution failed: ${reason}`));
    }
  }
}
