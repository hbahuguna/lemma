import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CheckOutcome,
  CheckStatus,
  evaluateScenarioCheck,
  negotiateBrowserDispatch,
  type BlockerDraft,
  type BrowserAdapter,
  type BrowserAdapterCapabilities,
  type Check,
  type ScenarioExecutionResult,
  type ScenarioPlan,
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
import { redactHarPayload, redactTraceBytes, type BrowserCaptureEvidenceStore } from "./capture.js";
import { executeScenarioPlan, loadScenarioPlan, loadScenarioPlanFromFile, type BrowserScenarioPageLike } from "./scenarios.js";

export interface PlaywrightModuleLike {
  chromium?: {
    launch?: (options?: Record<string, unknown>) => Promise<unknown>;
  };
  [key: string]: unknown;
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserRuntimeOptions {
  /** Disable browser execution and degrade all browser checks as blocked. */
  noBrowser?: boolean;
  /** Alias for noBrowser. */
  disabled?: boolean;
  /** Run browser headless (default true). Explicit true forces headless. */
  headless?: boolean;
  /** Request a visible browser window (headless false) unless headless is forced. */
  headed?: boolean;
  timeoutMs?: number;
  /** Browser viewport as "WxH" (e.g. "1440x900") or { width, height }. */
  viewport?: string | BrowserViewport;
  /** Viewport width (used with viewportHeight when viewport not provided). */
  viewportWidth?: number;
  /** Viewport height (used with viewportWidth when viewport not provided). */
  viewportHeight?: number;
  /** Enable mobile mode defaults (viewport/mobile context contracts). */
  mobile?: boolean;
  /** Alias for mobile. */
  mobilePack?: boolean;
  /** Mobile viewport override/default (e.g. "390x844" or { width, height }). */
  mobileViewport?: string | BrowserViewport;
  /** Alias for mobileViewport. */
  mobile_viewport?: string | BrowserViewport;
  /** Enable bounded same-origin crawl (LEM-054). */
  crawl?: boolean;
  /** Maximum pages to capture/evaluate when crawling (seed included). */
  maxPages?: number;
  /** Alias for maxPages. */
  max_pages?: number;
  /** Enable safe active browser probes (default false; probes may be unimplemented). */
  active?: boolean;
  /** Allow interactive active-probe actions when active probing is enabled (default true). */
  activeInteractions?: boolean;
  /** Alias for activeInteractions. */
  active_interactions?: boolean;
  /**
   * Authenticated Playwright storage state: file path, `env:VAR`, or resolved
   * state object (LEM-056). Resolved/injected state must not be persisted.
   */
  storageState?: string | Record<string, unknown>;
  /** Alias for storageState. */
  storage_state?: string | Record<string, unknown>;
  /** Capture and persist a redacted HAR artifact (disabled by default). */
  captureHar?: boolean;
  /** Alias for captureHar. */
  capture_har?: boolean;
  /** Capture and persist a redacted Playwright trace (disabled by default). */
  captureTrace?: boolean;
  /** Alias for captureTrace. */
  capture_trace?: boolean;
  /** Capture and persist browser video when available (disabled by default). */
  captureVideo?: boolean;
  /** Alias for captureVideo. */
  capture_video?: boolean;
  /** Precomputed scenario execution result for `browser.steps` (deterministic injection). */
  scenarioExecution?: ScenarioExecutionResult | Record<string, unknown>;
  /** Scenario plan object or JSON string for `browser.steps`. */
  scenarioPlan?: ScenarioPlan | Record<string, unknown> | string;
  /** Alias for scenarioPlan. */
  scenario?: ScenarioPlan | Record<string, unknown> | string;
  /** Natural-language scenario text to compile (heuristic) for `browser.steps`. */
  scenarioText?: string;
  /** Scenario file path (JSON plan or text) for `browser.steps`. */
  scenarioFile?: string;
  /** Alias for scenarioFile. */
  scenario_file?: string;
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

export const DEFAULT_BROWSER_VIEWPORT = "1440x900" as const;
export const DEFAULT_MOBILE_VIEWPORT = "390x844" as const;
export const DEFAULT_CRAWL_MAX_PAGES = 5 as const;

function parseViewportValue(
  value: unknown,
): { width: number; height: number; label: string } | null {
  if (typeof value === "string") {
    const m = /^\s*(\d+)x(\d+)\s*$/i.exec(value);
    if (m) {
      const width = Number(m[1]);
      const height = Number(m[2]);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return { width, height, label: `${width}x${height}` };
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const width = Number((value as { width?: unknown }).width);
    const height = Number((value as { height?: unknown }).height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height, label: `${width}x${height}` };
    }
  }
  return null;
}

export function resolveMobileEnabled(options?: BrowserRuntimeOptions): boolean {
  return options?.mobile === true || options?.mobilePack === true;
}

export function resolveHeadless(options?: BrowserRuntimeOptions): boolean {
  if (!options) return true;
  if (options.headless === true) return true;
  if (options.headed === true) return false;
  return options.headless ?? true;
}

export function resolveActiveDefaults(options?: BrowserRuntimeOptions): {
  active: boolean;
  activeInteractions: boolean;
} {
  const active = options?.active === true;
  const rawInteractions = options?.activeInteractions ?? options?.active_interactions;
  const activeInteractions = typeof rawInteractions === "boolean" ? rawInteractions : true;
  return { active, activeInteractions };
}

export function resolveBrowserMaxPages(options?: BrowserRuntimeOptions): number {
  const explicit = options?.maxPages ?? options?.max_pages;
  if (explicit !== undefined && explicit !== null) {
    const n = Math.trunc(Number(explicit));
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  return options?.crawl === true ? DEFAULT_CRAWL_MAX_PAGES : 1;
}

export function resolveBrowserViewport(options?: BrowserRuntimeOptions): BrowserViewport & { label: string } {
  const desktopFallback = { width: 1440, height: 900, label: DEFAULT_BROWSER_VIEWPORT };
  const mobileFallback = { width: 390, height: 844, label: DEFAULT_MOBILE_VIEWPORT };
  if (!options) return desktopFallback;

  const explicit = parseViewportValue(options.viewport);
  if (explicit) return explicit;

  const w = Number(options.viewportWidth);
  const h = Number(options.viewportHeight);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: w, height: h, label: `${w}x${h}` };
  }

  const mobile = resolveMobileEnabled(options);
  const mobileViewport = parseViewportValue(options.mobileViewport ?? options.mobile_viewport);
  if (mobileViewport) return mobileViewport;
  if (mobile) return mobileFallback;

  return desktopFallback;
}

function applyViewportMetadata(outcome: CheckOutcome, viewportLabel: string): CheckOutcome {
  if (outcome && outcome.metadata && typeof outcome.metadata === "object") {
    if (typeof outcome.metadata.viewport !== "string" || outcome.metadata.viewport.length === 0) {
      outcome.metadata.viewport = viewportLabel;
    }
  }
  return outcome;
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
  saveBytes?(
    name: string,
    data: Uint8Array | Buffer,
    kind?: string,
    description?: string,
    checkId?: string,
    suffix?: string,
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
  /** Optional injected Playwright-like page for scenario execution/testing. */
  scenarioPage?: BrowserScenarioPageLike;
  /** Optional viewport label ("WxH") to record on produced check outcomes. */
  viewport?: string;
  /** Optional browser adapter for negotiation/dispatch (LEM-191). */
  browserAdapter?: BrowserAdapter;
  /** Declared adapter capabilities override for negotiation/testing. */
  browserCapabilities?: Partial<BrowserAdapterCapabilities> | BrowserAdapterCapabilities;
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
  return resolveBrowserMaxPages(options);
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

function captureFlags(options?: BrowserRuntimeOptions) {
  return {
    har: options?.captureHar === true || options?.capture_har === true,
    trace: options?.captureTrace === true || options?.capture_trace === true,
    video: options?.captureVideo === true || options?.capture_video === true,
  };
}

async function saveJsonEvidence(
  evidence: BrowserCaptureEvidenceStore | undefined,
  name: string,
  payload: unknown,
  kind: string,
  description: string,
): Promise<string | undefined> {
  if (!evidence) return undefined;
  try {
    return await evidence.saveJson(name, payload, kind, description);
  } catch {
    return undefined;
  }
}

async function saveBytesEvidence(
  evidence: BrowserCaptureEvidenceStore | undefined,
  name: string,
  data: Uint8Array | Buffer,
  kind: string,
  description: string,
  suffix?: string,
): Promise<string | undefined> {
  if (!evidence?.saveBytes) return undefined;
  try {
    return await evidence.saveBytes(name, data, kind, description, undefined, suffix);
  } catch {
    return undefined;
  }
}

async function finalizeCaptureArtifacts(args: {
  evidence?: BrowserCaptureEvidenceStore;
  context: any;
  page: any;
  flags: { har: boolean; trace: boolean; video: boolean };
  harPath?: string;
  tracePath?: string;
  videoDir?: string;
}): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  const { evidence, context, page, flags, harPath, tracePath, videoDir } = args;

  // Trace must be stopped before closing context.
  if (flags.trace && tracePath) {
    try {
      await context?.tracing?.stop?.({ path: tracePath });
    } catch {
      // trace capture is best-effort
    }
  }

  // Resolve video path before context close when possible.
  let videoPath: string | undefined;
  if (flags.video) {
    try {
      const videoObj = page?.video?.();
      if (videoObj && typeof videoObj.path === "function") {
        videoPath = await videoObj.path();
      }
    } catch {
      videoPath = undefined;
    }
  }

  try {
    await context?.close?.();
  } catch {
    // close best-effort; continue artifact finalization
  }

  if (flags.har && harPath) {
    try {
      const raw = readFileSync(harPath, "utf8");
      const payload = JSON.parse(raw) as unknown;
      const redacted = redactHarPayload(payload);
      const ref = await saveJsonEvidence(
        evidence,
        "har-log",
        redacted,
        "har",
        "Redacted HTTP Archive for the browser run.",
      );
      if (ref) refs.har = ref;
    } catch {
      // HAR capture is best-effort
    } finally {
      try { unlinkSync(harPath); } catch { /* noop */ }
    }
  }

  if (flags.trace && tracePath) {
    try {
      const data = readFileSync(tracePath);
      const redacted = await redactTraceBytes(new Uint8Array(data));
      const ref = await saveBytesEvidence(
        evidence,
        "playwright-trace",
        Buffer.from(redacted),
        "trace",
        "Playwright trace for the browser run.",
        ".zip",
      );
      if (ref) refs.trace = ref;
    } catch {
      // trace capture is best-effort
    } finally {
      try { unlinkSync(tracePath); } catch { /* noop */ }
    }
  }

  if (flags.video && videoPath) {
    try {
      const data = readFileSync(videoPath);
      const suffix = videoPath.includes(".") ? videoPath.slice(videoPath.lastIndexOf(".")) : ".webm";
      const ref = await saveBytesEvidence(
        evidence,
        "browser-video",
        data,
        "video",
        "Browser video for the run.",
        suffix || ".webm",
      );
      if (ref) refs.video = ref;
    } catch {
      // video capture is best-effort
    } finally {
      try { unlinkSync(videoPath); } catch { /* noop */ }
      if (videoDir) {
        try { rmSync(videoDir, { recursive: true, force: true }); } catch { /* noop */ }
      }
    }
  } else if (videoDir) {
    try { rmSync(videoDir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  return refs;
}

export async function captureWithPlaywright(
  url: string,
  playwright: PlaywrightModuleLike,
  options: BrowserRuntimeOptions | undefined,
  evidence?: BrowserEvidenceStoreLike,
): Promise<BrowserPageView[]> {
  const chromium = playwright.chromium;
  if (!chromium || typeof chromium.launch !== "function") {
    throw new BrowserUnavailableError("Playwright Chromium launcher is unavailable.");
  }
  const headless = resolveHeadless(options);
  const viewport = resolveBrowserViewport(options);
  const mobile = resolveMobileEnabled(options);
  const storageStateInput = options?.storageState ?? options?.storage_state;
  const resolvedStorageState =
    storageStateInput !== undefined ? resolveBrowserStorageState(storageStateInput) : undefined;
  const flags = captureFlags(options);

  const browser = (await chromium.launch({ headless })) as {
    newContext: (opts?: Record<string, unknown>) => Promise<any>;
    close: () => Promise<void>;
  };

  const tempDir = (flags.har || flags.trace || flags.video)
    ? mkdtempSync(join(tmpdir(), "lemma-browser-capture-"))
    : undefined;
  const harPath = flags.har && tempDir ? join(tempDir, "capture.har") : undefined;
  const tracePath = flags.trace && tempDir ? join(tempDir, "capture-trace.zip") : undefined;
  const videoDir = flags.video && tempDir ? join(tempDir, "video") : undefined;

  const contextOptions: Record<string, unknown> = { viewport: { width: viewport.width, height: viewport.height } };
  if (mobile) {
    contextOptions.isMobile = true;
    contextOptions.hasTouch = true;
  }
  if (resolvedStorageState) {
    contextOptions.storageState = resolvedStorageState;
  }
  if (harPath) {
    contextOptions.recordHar = { path: harPath, mode: "minimal" };
    // compatibility with older Playwright option names
    (contextOptions as any).record_har_path = harPath;
  }
  if (videoDir) {
    contextOptions.recordVideo = { dir: videoDir, size: { width: 1280, height: 720 } };
    (contextOptions as any).record_video_dir = videoDir;
  }

  let context: any;
  let page: any;
  let views: BrowserPageView[] = [];
  try {
    context = await browser.newContext(contextOptions);
    if (flags.trace) {
      try {
        await context?.tracing?.start?.({ screenshots: true, snapshots: true, sources: true });
      } catch {
        // tracing start is best-effort
      }
    }
    page = await context.newPage();

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
  } finally {
    const artifactRefs = context
      ? await finalizeCaptureArtifacts({
          ...(evidence ? { evidence } : {}),
          context,
          page,
          flags,
          ...(harPath ? { harPath } : {}),
          ...(tracePath ? { tracePath } : {}),
          ...(videoDir ? { videoDir } : {}),
        })
      : {};
    if (Object.keys(artifactRefs).length > 0) {
      views = views.map((v) => normalizePageView({ ...v, evidenceRefs: { ...v.evidenceRefs, ...artifactRefs } }));
    }
    try { await browser.close(); } catch { /* noop */ }
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }

  return views;
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */


function toScenarioOutcome(execution: ScenarioExecutionResult | null | undefined): CheckOutcome {
  const out = evaluateScenarioCheck(execution);
  const findings = Array.isArray(out.findings)
    ? out.findings.map((f) => {
        const ev = (f as { evidence?: unknown }).evidence;
        return {
          ...f,
          evidence: Array.isArray(ev) ? ev.filter((x): x is string => typeof x === "string") : [],
        };
      })
    : [];
  return new CheckOutcome({
    status: out.status,
    actual: out.actual,
    evidence: Array.isArray(out.evidence) ? out.evidence : [],
    findings,
    metadata: out.metadata && typeof out.metadata === "object" ? (out.metadata) : {},
  });
}

function resolveScenarioPlanInput(input: RunBrowserChecksInput): ScenarioPlan | null {
  const opts = input.options ?? {};
  const baseUrl = input.url;
  const fromFile = opts.scenarioFile ?? opts.scenario_file;
  try {
    if (typeof fromFile === "string" && fromFile.trim()) {
      return loadScenarioPlanFromFile(fromFile, { baseUrl });
    }
    const planInput = opts.scenarioPlan ?? opts.scenario ?? opts.scenarioText;
    if (planInput !== undefined && planInput !== null) {
      if (typeof planInput === "string") {
        if (planInput.trim() === "") return null;
        return loadScenarioPlan(planInput, { baseUrl });
      }
      const rec = planInput as Record<string, unknown>;
      if (Array.isArray(rec.steps) && typeof rec.title === "string") {
        return loadScenarioPlan(rec, { baseUrl });
      }
      return loadScenarioPlan(rec, { baseUrl });
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeScenarioExecution(value: unknown): ScenarioExecutionResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.passed !== "boolean" || typeof v.total_steps !== "number") return null;
  return {
    title: typeof v.title === "string" ? v.title : "Scenario",
    target_url: typeof v.target_url === "string" ? v.target_url : (typeof v.targetUrl === "string" ? v.targetUrl : ""),
    passed: v.passed,
    total_steps: v.total_steps,
    passed_steps: typeof v.passed_steps === "number" ? v.passed_steps : 0,
    failed_steps: typeof v.failed_steps === "number" ? v.failed_steps : 0,
    skipped_steps: typeof v.skipped_steps === "number" ? v.skipped_steps : 0,
    duration_ms: typeof v.duration_ms === "number" ? v.duration_ms : 0,
    results: Array.isArray(v.results) ? (v.results as ScenarioExecutionResult["results"]) : [],
    evidence_refs: v.evidence_refs && typeof v.evidence_refs === "object" ? (v.evidence_refs as Record<string, string>) : {},
    error: typeof v.error === "string" ? v.error : "",
  };
}

async function resolveBrowserStepsOutcome(input: RunBrowserChecksInput, probeAvailable: boolean): Promise<CheckOutcome> {
  const opts = input.options ?? {};
  const injected = normalizeScenarioExecution(opts.scenarioExecution);
  if (injected) return toScenarioOutcome(injected);

  const plan = resolveScenarioPlanInput(input);
  if (!plan) {
    return blockedBrowserOutcome({ id: "browser.steps", title: "Scenario steps" } as Check, "No scenario plan or execution was provided for browser.steps.");
  }

  // If an injectable page is provided, execute directly (deterministic/test path).
  if (input.scenarioPage) {
    try {
      const execOpts = opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs };
      const exec = await executeScenarioPlan(input.scenarioPage, plan, input.evidence, execOpts);
      return toScenarioOutcome(exec);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return blockedBrowserOutcome({ id: "browser.steps", title: "Scenario steps" } as Check, `Scenario execution could not run: ${reason}`);
    }
  }

  if (!probeAvailable) {
    return blockedBrowserOutcome({ id: "browser.steps", title: "Scenario steps" } as Check, "Browser runtime is unavailable for scenario execution.");
  }

  // Best-effort: run scenario in a lightweight Playwright session.
  try {
    const probe = await probeBrowserRuntime(opts);
    if (!probe.available || !probe.playwright) {
      return blockedBrowserOutcome({ id: "browser.steps", title: "Scenario steps" } as Check, probe.reason ?? "Browser runtime is unavailable for scenario execution.");
    }
    const chromium = probe.playwright.chromium as { launch?: (options?: Record<string, unknown>) => Promise<unknown> } | undefined;
    if (!chromium || typeof chromium.launch !== "function") {
      return blockedBrowserOutcome({ id: "browser.steps", title: "Scenario steps" } as Check, "Playwright Chromium launcher is unavailable for scenario execution.");
    }
    const browser = (await chromium.launch({ headless: resolveHeadless(opts) })) as {
      newContext: (opts?: Record<string, unknown>) => Promise<{ newPage: () => Promise<BrowserScenarioPageLike>; close: () => Promise<void> }>;
      close: () => Promise<void>;
    };
    const scenarioViewport = resolveBrowserViewport(opts);
    const context = await browser.newContext({ viewport: { width: scenarioViewport.width, height: scenarioViewport.height } });
    const page = await context.newPage();
    try {
      const execOpts = { label: "scenario", ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) };
      const exec = await executeScenarioPlan(page, plan, input.evidence, execOpts);
      return toScenarioOutcome(exec);
    } finally {
      try { await context.close(); } catch { /* noop */ }
      try { await browser.close(); } catch { /* noop */ }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return blockedBrowserOutcome({ id: "browser.steps", title: "Scenario steps" } as Check, `Scenario execution could not run: ${reason}`);
  }
}

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
  const viewportLabel = input.viewport ?? resolveBrowserViewport(options).label;
  const emit = async (check: Check, outcome: CheckOutcome): Promise<void> => {
    await onOutcome(check, applyViewportMetadata(outcome, viewportLabel));
  };

  const hasSteps = checks.some((c) => c.id === "browser.steps");
  const nonSteps = checks.filter((c) => c.id !== "browser.steps");

  let stepsOutcome: CheckOutcome | null = null;
  if (hasSteps) {
    const injected = normalizeScenarioExecution(options?.scenarioExecution);
    if (injected) {
      stepsOutcome = toScenarioOutcome(injected);
    }
  }

  const probe = await probeBrowserRuntime(options);
  if (!probe.available || !probe.playwright) {
    const reason = probe.reason ?? "Browser runtime is unavailable.";
    if (nonSteps.length > 0) {
      await degradeBrowserChecks(nonSteps, reason, emit);
    }
    if (hasSteps) {
      const out = stepsOutcome ?? (await resolveBrowserStepsOutcome(input, false));
      for (const check of checks.filter((c) => c.id === "browser.steps")) {
        // Preserve injected/precomputed execution outcomes; otherwise block with actionable reason.
        await emit(check, stepsOutcome ? stepsOutcome : (out.status === CheckStatus.BLOCKED ? out : blockedBrowserOutcome(check, reason)));
      }
    } else if (nonSteps.length === 0) {
      await degradeBrowserChecks(checks, reason, emit);
    }
    return;
  }

  // Capability negotiation / re-plan (LEM-191): when runtime is available, missing required channels
  // must not be silently dropped or fabricated as passes. Re-planned checks are skipped with explicit
  // coverage notes. Blocked-runtime behavior above is preserved (LEM-050).
  const defaultCapabilities: BrowserAdapterCapabilities = {
    navigation: true,
    screenshots: true,
    console: true,
    network: true,
    storage: true,
    viewport: true,
    crawl: true,
  };
  const declaredCaps = input.browserCapabilities ?? (input.browserAdapter ? await Promise.resolve((input.browserAdapter as any).capabilities?.() ?? defaultCapabilities) : undefined);
  const capabilities: BrowserAdapterCapabilities = { ...defaultCapabilities, ...(declaredCaps && typeof declaredCaps === "object" ? declaredCaps : {}) };
  const negotiationAdapter: BrowserAdapter = (input.browserAdapter as any) ?? {
    id: "playwright",
    version: "1.0.0",
    nativeVersion: null,
    capabilities: () => capabilities,
    dispatch: async () => ({ outcomes: new Map() }),
  };
  const negotiation = negotiateBrowserDispatch(negotiationAdapter, capabilities, checks, options as any);
  const replannedIds = new Set(negotiation.replanned_checks);
  for (const item of negotiation.plan) {
    if (item.action !== "replan_skip") continue;
    const check = checks.find((c) => c.id === item.check_id);
    if (!check) continue;
    const note = item.coverage_note || `Browser check '${check.id}' re-planned due to missing adapter channel(s).`;
    const outcome = new CheckOutcome({
      status: CheckStatus.SKIPPED,
      actual: note,
      evidence: [],
      findings: [],
      blocker: null,
      metadata: {
        limitation: note,
        coverage_note: note,
        replanned: true,
        missing_channels: item.missing_channels,
        adapter_id: negotiation.adapter.adapter_id,
        not_a_pass: true,
      },
    });
    await emit(check, outcome);
  }
  const dispatchChecks = checks.filter((c) => !replannedIds.has(c.id));
  if (dispatchChecks.length === 0) return;

  // If browser.steps was replanned, do not execute it; otherwise preserve injected/precomputed outcome handling.
  const dispatchHasSteps = dispatchChecks.some((c) => c.id === "browser.steps");
  const dispatchNonSteps = dispatchChecks.filter((c) => c.id !== "browser.steps");

  let views: BrowserPageView[] | null = null;
  if (dispatchNonSteps.length > 0 || (dispatchHasSteps && !stepsOutcome)) {
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
        await degradeBrowserChecks(dispatchChecks, reason, emit);
        return;
      }
    }
  }

  if ((dispatchNonSteps.length > 0) && (!views || views.length === 0)) {
    await degradeBrowserChecks(dispatchChecks, "No browser page view could be captured.", emit);
    return;
  }

  const multi = !!views && (views.length > 1 || (options?.crawl === true && getMaxPages(options) > 1));

  if (dispatchHasSteps && !stepsOutcome) {
    stepsOutcome = await resolveBrowserStepsOutcome({ ...input, checks: dispatchChecks }, true);
  }

  const findSourceScreenshotRef = (): string | null => {
    for (const v of views ?? []) {
      const ref = v?.evidenceRefs?.screenshot;
      if (typeof ref === "string" && ref) return ref;
    }
    return null;
  };
  const ensurePerCheckScreenshot = async (check: Check, outcome: CheckOutcome): Promise<void> => {
    if (!evidence || typeof (evidence as any).saveScreenshot !== "function") return;
    if (outcome.status === CheckStatus.BLOCKED) return;
    // if already has a screenshot in check-specific path, keep it
    const hasCheckScreenshot = (outcome.evidence ?? []).some((r) => typeof r === "string" && r.includes(`/${check.id}/screenshot-`));
    if (hasCheckScreenshot) return;
    const srcRef = findSourceScreenshotRef();
    if (!srcRef) return;
    const store: any = evidence as any;
    if (typeof store.readEvidenceArtifact !== "function") return;
    try {
      const art = await store.readEvidenceArtifact(srcRef);
      if (!art || !art.data) return;
      // Redaction policy (LEM-144): if associated captured text evidence for this check indicates known secret values,
      // do not capture/duplicate screenshot for the check and mark redaction note instead of fabricating/embedding.
      let redacted = false;
      const textRefKeys = ["snapshot", "console", "network", "navigation", "headers"];
      for (const v of views ?? []) {
        for (const k of textRefKeys) {
          const ref = (v.evidenceRefs ?? {})[k];
          if (typeof ref !== "string" || !ref) continue;
          try {
            const t = await store.readEvidenceArtifact(ref);
            if (!t?.data) continue;
            const txt = t.data.toString("utf8");
            // known secret markers/pattern hints (best-effort; core redaction corpus patterns)
            if (/(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-|Bearer\s+[A-Za-z0-9._~+\-\/]+=*|sk_(live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z\-_]{35})/.test(txt)) {
              redacted = true;
              break;
            }
          } catch { /* ignore */ }
        }
        if (redacted) break;
      }
      if (redacted) {
        outcome.metadata = { ...(outcome.metadata ?? {}), screenshot_redacted: true, redaction_note: "Screenshot withheld by redaction policy (associated evidence contained secret-like values)." };
        return;
      }
      const checkRef = await store.saveScreenshot(`screenshot-${check.id}`, art.data, `Full-page screenshot for ${check.id}`, check.id);
      if (typeof checkRef === "string" && checkRef) {
        outcome.evidence = [...(outcome.evidence ?? []), checkRef];
      }
    } catch {
      // best-effort; do not fail check
    }
  };

  for (const check of dispatchChecks) {
    try {
      if (check.id === "browser.steps") {
        await emit(
          check,
          stepsOutcome ?? blockedBrowserOutcome(check, "No scenario plan or execution was provided for browser.steps."),
        );
        continue;
      }
      if (!IMPLEMENTED_BROWSER_CHECKS.has(check.id)) {
        await emit(check, notImplementedOutcome(check));
        continue;
      }
      if (!views || views.length === 0) {
        await emit(check, blockedBrowserOutcome(check, "No browser page view could be captured."));
        continue;
      }
      const outcome = multi
        ? evaluateBrowserCheckAcrossViews(check, views)
        : evaluateBrowserCheckForCheck(check, views[0]!);
      await ensurePerCheckScreenshot(check, outcome);
      await emit(check, outcome);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await emit(check, blockedBrowserOutcome(check, `Browser check execution failed: ${reason}`));
    }
  }
}
