import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
// capture evidence store types are satisfied via BrowserEvidenceStoreLike in this module.
import { executeScenarioPlan, loadScenarioPlan, loadScenarioPlanFromFile, type BrowserScenarioPageLike } from "./scenarios.js";
import { runAutomaticInteractions } from "./interactions.js";

/** Legacy type kept for API compatibility (Playwright removed; CDP runtime handle used internally). */
export interface PlaywrightModuleLike {
  [key: string]: unknown;
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserRuntimeOptions {
  noBrowser?: boolean;
  disabled?: boolean;
  headless?: boolean;
  headed?: boolean;
  timeoutMs?: number;
  viewport?: string | BrowserViewport;
  viewportWidth?: number;
  viewportHeight?: number;
  mobile?: boolean;
  mobilePack?: boolean;
  mobileViewport?: string | BrowserViewport;
  mobile_viewport?: string | BrowserViewport;
  crawl?: boolean;
  maxPages?: number;
  max_pages?: number;
  active?: boolean;
  activeInteractions?: boolean;
  active_interactions?: boolean;
  storageState?: string | Record<string, unknown>;
  storage_state?: string | Record<string, unknown>;
  captureHar?: boolean;
  capture_har?: boolean;
  captureTrace?: boolean;
  capture_trace?: boolean;
  captureVideo?: boolean;
  capture_video?: boolean;
  scenarioExecution?: ScenarioExecutionResult | Record<string, unknown>;
  scenarioPlan?: ScenarioPlan | Record<string, unknown> | string;
  scenario?: ScenarioPlan | Record<string, unknown> | string;
  scenarioText?: string;
  scenarioFile?: string;
  scenario_file?: string;
  /** Test/extension hook: override chrome executable path or runtime validation */
  playwrightLoader?: () => Promise<PlaywrightModuleLike>;
  runtimeValidator?: (runtime: PlaywrightModuleLike) => Promise<void> | void;
  chromePath?: string;
}

export const DEFAULT_BROWSER_VIEWPORT = "1440x900" as const;
export const DEFAULT_MOBILE_VIEWPORT = "390x844" as const;
export const DEFAULT_CRAWL_MAX_PAGES = 5 as const;

function parseViewportValue(value: unknown): { width: number; height: number; label: string } | null {
  if (typeof value === "string") {
    const m = /^\s*(\d+)x(\d+)\s*$/i.exec(value);
    if (m) {
      const width = Number(m[1]); const height = Number(m[2]);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height, label: `${width}x${height}` };
    }
    return null;
  }
  if (value && typeof value === "object") {
    const width = Number((value as any).width); const height = Number((value as any).height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height, label: `${width}x${height}` };
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

export function resolveActiveDefaults(options?: BrowserRuntimeOptions): { active: boolean; activeInteractions: boolean } {
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
  const w = Number(options.viewportWidth); const h = Number(options.viewportHeight);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h, label: `${w}x${h}` };
  const mobile = resolveMobileEnabled(options);
  const mobileViewport = parseViewportValue(options.mobileViewport ?? options.mobile_viewport);
  if (mobileViewport) return mobileViewport;
  if (mobile) return mobileFallback;
  return desktopFallback;
}

function applyViewportMetadata(outcome: CheckOutcome, viewportLabel: string): CheckOutcome {
  if (outcome && outcome.metadata && typeof outcome.metadata === "object") {
    if (typeof (outcome.metadata as any).viewport !== "string" || (outcome.metadata as any).viewport.length === 0) {
      (outcome.metadata as any).viewport = viewportLabel;
    }
  }
  return outcome;
}

export interface BrowserProbeResult {
  available: boolean;
  reason?: string;
  /** CDP runtime handle (kept as `playwright` for backward-compatible call sites). */
  playwright?: PlaywrightModuleLike & { __cdp?: { chromePath: string } };
}

export class BrowserUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = "BrowserUnavailableError"; this.reason = reason; }
}

export type BrowserStorageStateInput = string | Record<string, unknown>;

export function resolveBrowserStorageState(value: BrowserStorageStateInput): Record<string, unknown> {
  if (value && typeof value === "object") { validateBrowserStorageState(value); return value; }
  let raw: string | undefined;
  if (typeof value === "string" && value.startsWith("env:")) {
    const variable = value.slice(4);
    raw = process.env[variable];
    if (raw === undefined) throw new BrowserUnavailableError(`Storage state environment variable '${variable}' is not set.`);
  } else if (typeof value === "string") {
    try { raw = readFileSync(value, "utf8"); } catch { throw new BrowserUnavailableError(`Storage state file was not found: ${value}`); }
  } else {
    throw new BrowserUnavailableError("Storage state is not valid JSON.");
  }
  let state: unknown;
  try { state = JSON.parse(raw); } catch { throw new BrowserUnavailableError("Storage state is not valid JSON."); }
  validateBrowserStorageState(state);
  return state;
}

function validateBrowserStorageState(state: unknown): asserts state is Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new BrowserUnavailableError("Storage state must be a JSON object.");
  const obj = state as Record<string, unknown>;
  const cookies = obj.cookies; const origins = obj.origins;
  if (!Array.isArray(cookies) || !Array.isArray(origins)) throw new BrowserUnavailableError("Storage state cookies and origins must be arrays.");
  const now = Date.now() / 1000;
  let hasValidCookie = false;
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) throw new BrowserUnavailableError("Storage state contains an invalid cookie entry.");
    const expires = (cookie as Record<string, unknown>).expires;
    if (expires === undefined || expires === null || expires === 0 || expires === -1) hasValidCookie = true;
    else if (typeof expires === "number" && Number.isFinite(expires)) { if (expires > now) hasValidCookie = true; }
  }
  if (cookies.length > 0 && !hasValidCookie && origins.length === 0) throw new BrowserUnavailableError("Storage state has expired; provide a fresh state file or secret.");
  if (cookies.length === 0 && origins.length === 0) throw new BrowserUnavailableError("Storage state is empty.");
}

const DEFAULT_INSTALL_HINT = "Install Google Chrome or Chromium and ensure it is discoverable (or set CHROME_PATH / LEMMA_CHROME_PATH), then rerun the check.";

export function browserDisabledReason(options?: BrowserRuntimeOptions): string | null {
  if (options?.noBrowser || options?.disabled) return "Browser execution is disabled (--no-browser).";
  return null;
}

function detectChromePath(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.LEMMA_CHROME_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    // Linux
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter((x): x is string => !!x);
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/** Legacy loader kept for compatibility; resolves when a Chrome/Chromium binary is available. */
export async function loadPlaywright(options?: BrowserRuntimeOptions): Promise<PlaywrightModuleLike & { __cdp: { chromePath: string } }> {
  const chromePath = detectChromePath(options?.chromePath);
  if (!chromePath) throw new BrowserUnavailableError("Chrome/Chromium runtime is unavailable: no Chrome/Chromium executable found.");
  const runtime = { __cdp: { chromePath } } as PlaywrightModuleLike & { __cdp: { chromePath: string } };
  if (options?.runtimeValidator) await options.runtimeValidator(runtime);
  return runtime;
}

export async function probeBrowserRuntime(options?: BrowserRuntimeOptions): Promise<BrowserProbeResult> {
  const disabled = browserDisabledReason(options);
  if (disabled) return { available: false, reason: disabled };
  try {
    const runtime = await loadPlaywright(options);
    return { available: true, playwright: runtime };
  } catch (error) {
    const reason = error instanceof BrowserUnavailableError ? error.reason : (error instanceof Error ? error.message : String(error));
    return { available: false, reason };
  }
}

function blockerDraftForUnavailable(check: Check, reason: string): BlockerDraft {
  const boundary = reason.includes("Browser execution") ? reason : `Browser execution is unavailable: ${reason}`;
  return {
    attempted_action: check.title || check.id,
    boundary,
    unblock_evidence: [DEFAULT_INSTALL_HINT, `Provide a runnable browser target and Chrome/Chromium, then rerun check '${check.id}'.`],
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
    metadata: { limitation: reason, blocked_by: "browser_runtime" },
  });
}

function notImplementedOutcome(check: Check): CheckOutcome {
  const reason = `Browser check '${check.id}' is not implemented in this runtime slice.`;
  return new CheckOutcome({
    status: CheckStatus.BLOCKED,
    actual: reason,
    evidence: [],
    findings: [],
    blocker: { attempted_action: check.title || check.id, boundary: reason, unblock_evidence: [`Run check '${check.id}' with a browser runtime slice that implements it, or exclude it from this run.`], covered_elsewhere: false, covered_by: [] },
    metadata: { limitation: reason, blocked_by: "browser_runtime", not_implemented: true },
  });
}

export type BrowserOutcomeCallback = (check: Check, outcome: CheckOutcome) => unknown;

export interface BrowserEvidenceStoreLike {
  saveJson(name: string, payload: unknown, kind?: string, description?: string, checkId?: string): Promise<string> | string;
  saveScreenshot?(name: string, data: Uint8Array | Buffer, description?: string, checkId?: string): Promise<string> | string;
  saveBytes?(name: string, data: Uint8Array | Buffer, kind?: string, description?: string, checkId?: string, suffix?: string): Promise<string> | string;
}

export interface RunBrowserChecksInput {
  url: string;
  checks: readonly Check[];
  onOutcome: BrowserOutcomeCallback;
  options?: BrowserRuntimeOptions;
  pageView?: BrowserPageView | Record<string, unknown>;
  pageViews?: ReadonlyArray<BrowserPageView | Record<string, unknown>>;
  views?: ReadonlyArray<BrowserPageView | Record<string, unknown>>;
  evidence?: BrowserEvidenceStoreLike;
  scenarioPage?: BrowserScenarioPageLike;
  viewport?: string;
  browserAdapter?: BrowserAdapter;
  browserCapabilities?: Partial<BrowserAdapterCapabilities> | BrowserAdapterCapabilities;
}

export async function degradeBrowserChecks(checks: readonly Check[], reason: string, onOutcome: BrowserOutcomeCallback): Promise<void> {
  for (const check of checks) await onOutcome(check, blockedBrowserOutcome(check, reason));
}

// -------- CDP implementation (replaces Playwright for lemma browser capture) --------

// (legacy helper removed; FlatCdp is used for CDP capture)

async function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function launchChromeAndGetWsUrl(chromePath: string, headless: boolean, userDataDir: string, timeoutMs: number): Promise<{ wsUrl: string; proc: ChildProcess }> {
  const args = [
    `--remote-debugging-port=0`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--safebrowsing-disable-auto-update",
  ];
  if (headless) args.push("--headless=new", "--disable-gpu");
  const proc = spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.on("data", (d) => { stderr += String(d); });
  const deadline = Date.now() + Math.max(2000, timeoutMs);
  while (Date.now() < deadline) {
    const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
    if (m) return { wsUrl: m[1]!, proc };
    if (proc.exitCode !== null) break;
    await wait(50);
  }
  try { proc.kill(); } catch {}
  throw new BrowserUnavailableError(`Failed to start Chrome DevTools endpoint. ${stderr.trim() ? `stderr: ${stderr.trim().slice(0, 300)}` : "No DevTools endpoint found."}`);
}

// Flat CDP client supporting flattened sessions (used for browser capture).
class FlatCdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private listeners = new Set<(msg: any) => void>();
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: any) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!; this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || "CDP error")); else p.resolve(msg.result);
        }
        for (const l of this.listeners) l(msg);
      } catch {}
    });
    ws.addEventListener("close", () => { for (const [, p] of this.pending) p.reject(new Error("CDP closed")); this.pending.clear(); });
  }
  call(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload: any = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try { this.ws.send(JSON.stringify(payload)); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  on(fn: (msg: any) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { try { this.ws.close(); } catch {} }
}

async function captureOnePageCdp(url: string, options: BrowserRuntimeOptions | undefined, evidence: BrowserEvidenceStoreLike | undefined, label: string, chromePath: string): Promise<BrowserPageView> {
  const headless = resolveHeadless(options);
  const timeoutMs = options?.timeoutMs ?? 30000;
  const viewport = resolveBrowserViewport(options);
  const userDataDir = mkdtempSync(join(tmpdir(), "lemma-cdp-profile-"));
  let proc: ChildProcess | null = null; let ws: WebSocket | null = null; let cdp: FlatCdp | null = null;
  const consoleMessages: Array<Record<string, unknown>> = [];
  const pageErrors: Array<Record<string, unknown>> = [];
  const networkEntries: Array<Record<string, unknown>> = [];
  const navigation: { url: string; finalUrl: string; status?: number | null; headers?: Record<string, string>; error?: string } = { url, finalUrl: url };
  const evidenceRefs: Record<string, string> = {};
  try {
    const launched = await launchChromeAndGetWsUrl(chromePath, headless, userDataDir, Math.max(timeoutMs, 15000));
    proc = launched.proc;
    ws = new WebSocket(launched.wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new BrowserUnavailableError("CDP websocket connect timeout")), 10000);
      ws!.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws!.addEventListener("error", () => { clearTimeout(t); reject(new BrowserUnavailableError("CDP websocket connection failed")); });
    });
    cdp = new FlatCdp(ws);
    const target = await cdp.call("Target.createTarget", { url: "about:blank" });
    const targetId = target?.targetId;
    let sessionId: string | undefined;
    try { const attached = await cdp.call("Target.attachToTarget", { targetId, flatten: true }); sessionId = attached?.sessionId; } catch {}
    const sid = sessionId;
    const reqMeta = new Map<string, any>();
    cdp.on((msg) => {
      if (sid && msg.sessionId !== sid) return;
      const m = msg.method; const p = msg.params || {};
      if (m === "Runtime.consoleAPICalled") {
        const text = (p.args || []).map((a: any) => (a?.value ?? a?.description ?? "")).join(" ");
        consoleMessages.push({ type: p.type || "log", text: String(text) });
      } else if (m === "Runtime.exceptionThrown") {
        const d = p.exceptionDetails || {}; const txt = d.text || d.exception?.description || d.exception?.value || "page error";
        pageErrors.push({ text: String(txt) });
      } else if (m === "Log.entryAdded") {
        const e = p.entry || {}; consoleMessages.push({ type: e.level || "log", text: String(e.text || "") });
      } else if (m === "Network.requestWillBeSent") {
        reqMeta.set(p.requestId, { url: p.request?.url, method: p.request?.method });
      } else if (m === "Network.responseReceived") {
        const meta = reqMeta.get(p.requestId) || {};
        networkEntries.push({ url: String(p.response?.url || meta.url || ""), status: p.response?.status, failed: false });
        if (p.type === "Document" && (!navigation.status || String(p.response?.url||"").startsWith("http"))) {
          if (!navigation.status) navigation.status = p.response?.status;
          const headers: Record<string,string> = {};
          for (const [k,v] of Object.entries(p.response?.headers || {})) headers[String(k).toLowerCase()] = String(v);
          navigation.headers = headers;
        }
      } else if (m === "Network.loadingFailed") {
        const meta = reqMeta.get(p.requestId) || {};
        networkEntries.push({ url: String(meta.url || ""), method: String(meta.method || "GET"), failed: true, failure: String(p.errorText || "request failed") });
      }
    });
    await cdp.call("Page.enable", {}, sid);
    await cdp.call("Runtime.enable", {}, sid);
    await cdp.call("Network.enable", {}, sid);
    await cdp.call("Log.enable", {}, sid).catch(() => {});
    try { await cdp.call("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: resolveMobileEnabled(options) }, sid); } catch {}
    try {
      const nav = await Promise.race([
        cdp.call("Page.navigate", { url }, sid).then(async (r) => {
          // wait for load a bit
          await new Promise<void>((resolve) => {
            let done = false;
            const off = cdp!.on((msg) => { if (sid && msg.sessionId !== sid) return; if (msg.method === "Page.loadEventFired") { if (!done) { done = true; off(); resolve(); } } });
            setTimeout(() => { if (!done) { done = true; off(); resolve(); } }, Math.min(timeoutMs, 15000));
          });
          return r;
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Navigation timeout after ${timeoutMs}ms`)), timeoutMs)),
      ]) as any;
      if (nav?.errorText) navigation.error = String(nav.errorText);
    } catch (e: any) {
      navigation.error = String(e?.message || e || "navigation failed");
    }
    try { const res = await cdp.call("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sid); if (res?.result?.value) navigation.finalUrl = String(res.result.value); } catch {}
    if (!navigation.finalUrl) navigation.finalUrl = url;

    let snapshot: Record<string, unknown> = {};
    try {
      if (!navigation.error) {
        const expr = `(() => { try { const doc = document; const bodyText = doc?.body?.innerText ?? doc?.body?.textContent ?? ""; const h1s = Array.from(doc?.querySelectorAll?.('h1') ?? []).map(n => String(n?.innerText ?? n?.textContent ?? '').trim()).filter(t => t.length>0); const links = Array.from(doc?.querySelectorAll?.('a') ?? []).map((a,i)=>({selector: 'a:nth-of-type('+(i+1)+')', href: String(a?.getAttribute?.('href') ?? ''), target: String(a?.getAttribute?.('target') ?? ''), rel: String(a?.getAttribute?.('rel') ?? ''), download: a?.hasAttribute?.('download') ? true : false })); return { title: String(doc?.title ?? ''), bodyTextLength: String(bodyText).trim().length, h1s, links }; } catch(e){ return {}; } })()`;
        const res = await cdp.call("Runtime.evaluate", { expression: expr, returnByValue: true }, sid);
        if (res?.result?.value && typeof res.result.value === "object") snapshot = res.result.value as Record<string, unknown>;
      }
    } catch {}

    const prefix = label === "landing" ? "" : `${label}-`;
    const shotName = label === "landing" ? "landing-page" : `${label}-page`;
    if (evidence) {
      try {
        evidenceRefs.navigation = await evidence.saveJson(`${prefix}navigation`, navigation, "navigation", label === "landing" ? "Browser navigation result" : `Navigation result for ${label}`);
        evidenceRefs.snapshot = await evidence.saveJson(`${prefix}dom-snapshot`, snapshot, "dom_snapshot", label === "landing" ? "Captured DOM snapshot" : `Sanitized DOM snapshot for ${label}`);
        evidenceRefs.console = await evidence.saveJson(`${prefix}console-log`, [...consoleMessages, ...pageErrors.map((e) => ({ type: "pageerror", ...e }))], "console_log", label === "landing" ? "Browser console and page errors" : `Console log for ${label}`);
        evidenceRefs.network = await evidence.saveJson(`${prefix}network-log`, networkEntries, "network_log", label === "landing" ? "Browser network entries" : `Network log for ${label}`);
      } catch {}
      try {
        if (evidence.saveScreenshot) {
          const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sid);
          if (shot?.data) {
            const buf = Buffer.from(String(shot.data), "base64");
            evidenceRefs.screenshot = await evidence.saveScreenshot(shotName, buf, label === "landing" ? "Landing page screenshot" : `Screenshot for ${label}`);
          }
        }
      } catch {}
    }
    try { if (targetId) await cdp.call("Target.closeTarget", { targetId }); } catch {}
    return normalizePageView({ navigation, snapshot, consoleMessages, pageErrors, networkEntries, evidenceRefs, label });
  } finally {
    try { cdp?.close(); } catch {}
    try { ws?.close(); } catch {}
    try { proc?.kill(); } catch {}
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

/** Capture using Chrome DevTools Protocol (replaces Playwright). Second arg kept for API compatibility. */
export async function captureWithPlaywright(
  url: string,
  runtimeOrPlaywright: PlaywrightModuleLike | undefined,
  options: BrowserRuntimeOptions | undefined,
  evidence?: BrowserEvidenceStoreLike,
): Promise<BrowserPageView[]> {
  const chromePath = (runtimeOrPlaywright as any)?.__cdp?.chromePath || detectChromePath(options?.chromePath);
  if (!chromePath) throw new BrowserUnavailableError("Chrome/Chromium runtime is unavailable: no Chrome/Chromium executable found.");

  const seed = await captureOnePageCdp(url, options, evidence, "landing", chromePath);
  const views: BrowserPageView[] = [seed];
  const crawl = options?.crawl === true;
  const maxPages = resolveBrowserMaxPages(options);
  if (crawl && maxPages > 1) {
    const discovered = discoverRoutes(seed.navigation.finalUrl || seed.navigation.url || url, seed.snapshot ?? {}, maxPages);
    for (let i = 0; i < discovered.length; i++) {
      const routeUrl = discovered[i]!;
      const label = routeLabel(routeUrl, i + 1);
      try {
        views.push(await captureOnePageCdp(routeUrl, options, evidence, label, chromePath));
      } catch {
        // best-effort crawl
      }
    }
  }
  return views;
}

/** Legacy alias maintained for compatibility. */
export async function loadPlaywrightRuntime(options?: BrowserRuntimeOptions) { return loadPlaywright(options); }

// ---- remaining APIs kept for compatibility; advanced Playwright-only features degrade explicitly ----

function toScenarioOutcome(execution: ScenarioExecutionResult | null | undefined): CheckOutcome {
  const out = evaluateScenarioCheck(execution);
  const findings = Array.isArray(out.findings) ? out.findings.map((f) => ({ ...f, evidence: Array.isArray((f as any).evidence) ? (f as any).evidence.filter((x: any) => typeof x === "string") : [] })) : [];
  return new CheckOutcome({ status: out.status, actual: out.actual, evidence: Array.isArray(out.evidence) ? out.evidence : [], findings, metadata: out.metadata && typeof out.metadata === "object" ? out.metadata : {} });
}
function resolveScenarioPlanInput(input: RunBrowserChecksInput): ScenarioPlan | null {
  const opts = input.options ?? {}; const baseUrl = input.url; const fromFile = (opts as any).scenarioFile ?? (opts as any).scenario_file;
  try {
    if (typeof fromFile === "string" && fromFile.trim()) return loadScenarioPlanFromFile(fromFile, { baseUrl });
    const planInput = (opts as any).scenarioPlan ?? (opts as any).scenario ?? (opts as any).scenarioText;
    if (planInput !== undefined && planInput !== null) {
      if (typeof planInput === "string") { if (planInput.trim() === "") return null; return loadScenarioPlan(planInput, { baseUrl }); }
      const rec = planInput as Record<string, unknown>;
      if (Array.isArray(rec.steps) && typeof rec.title === "string") return loadScenarioPlan(rec, { baseUrl });
      return loadScenarioPlan(rec, { baseUrl });
    }
  } catch { return null; }
  return null;
}
function normalizeScenarioExecution(value: unknown): ScenarioExecutionResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.passed !== "boolean" || typeof v.total_steps !== "number") return null;
  return { title: typeof v.title === "string" ? v.title : "Scenario", target_url: typeof v.target_url === "string" ? v.target_url : (typeof v.targetUrl === "string" ? v.targetUrl : ""), passed: v.passed, total_steps: v.total_steps, passed_steps: typeof v.passed_steps === "number" ? v.passed_steps : 0, failed_steps: typeof v.failed_steps === "number" ? v.failed_steps : 0, skipped_steps: typeof v.skipped_steps === "number" ? v.skipped_steps : 0, duration_ms: typeof v.duration_ms === "number" ? v.duration_ms : 0, results: Array.isArray(v.results) ? (v.results as any) : [], evidence_refs: v.evidence_refs && typeof v.evidence_refs === "object" ? (v.evidence_refs as any) : {}, error: typeof v.error === "string" ? v.error : "" };
}

async function runCdpAutomaticSteps(url: string, options: BrowserRuntimeOptions | undefined, evidence: BrowserEvidenceStoreLike | undefined, label: string): Promise<CheckOutcome> {
  const chromePath = detectChromePath(options?.chromePath);
  if (!chromePath) return blockedBrowserOutcome({ id: "browser.steps", title: "Scenario steps" } as Check, "Chrome/Chromium runtime is unavailable: no Chrome/Chromium executable found.");
  const headless = resolveHeadless(options);
  const timeoutMs = options?.timeoutMs ?? 30000;
  const viewport = resolveBrowserViewport(options);
  const userDataDir = mkdtempSync(join(tmpdir(), "lemma-cdp-steps-"));
  let proc: ChildProcess | null = null; let ws: WebSocket | null = null; let cdp: FlatCdp | null = null;
  try {
    const launched = await launchChromeAndGetWsUrl(chromePath, headless, userDataDir, Math.max(timeoutMs, 15000));
    proc = launched.proc;
    ws = new WebSocket(launched.wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new BrowserUnavailableError("CDP websocket connect timeout")), 10000);
      ws!.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws!.addEventListener("error", () => { clearTimeout(t); reject(new BrowserUnavailableError("CDP websocket connection failed")); });
    });
    cdp = new FlatCdp(ws);
    const target = await cdp.call("Target.createTarget", { url: "about:blank" });
    const targetId = target?.targetId;
    let sessionId: string | undefined;
    try { const attached = await cdp.call("Target.attachToTarget", { targetId, flatten: true }); sessionId = attached?.sessionId; } catch {}
    const sid = sessionId;
    await cdp.call("Page.enable", {}, sid);
    await cdp.call("Runtime.enable", {}, sid);
    await cdp.call("Network.enable", {}, sid).catch(() => {});
    try { await cdp.call("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: resolveMobileEnabled(options) }, sid); } catch {}
    await cdp.call("Page.navigate", { url }, sid);
    await new Promise<void>((resolve) => {
      let done = false;
      const off = cdp!.on((msg) => { if (sid && msg.sessionId !== sid) return; if (msg.method === "Page.loadEventFired") { if (!done) { done = true; off(); resolve(); } } });
      setTimeout(() => { if (!done) { done = true; off(); resolve(); } }, Math.min(timeoutMs, 15000));
    });
    const exec = await runAutomaticInteractions({
      call: (m, p, s) => cdp!.call(m, p, s),
      ...(sid ? { sessionId: sid } : {}),
      baseUrl: url,
      ...(evidence ? { evidence } : {}),
      timeoutMs: Math.min(timeoutMs, 10000),
      label,
    });
    if (evidence) {
      try { await evidence.saveJson(`${label}-interaction-plan`, exec.plan, "scenario", `Auto-discovered interaction plan for ${label}`); } catch {}
      try { await evidence.saveJson(`${label}-interaction-results`, exec, "scenario_result", `Auto interaction execution results for ${label}`); } catch {}
    }
    try { if (targetId) await cdp.call("Target.closeTarget", { targetId }); } catch {}
    return toScenarioOutcome(exec);
  } catch (e) {
    const reason = e instanceof BrowserUnavailableError ? e.reason : (e instanceof Error ? e.message : String(e));
    return blockedBrowserOutcome({ id: "browser.steps", title: "Scenario steps" } as Check, reason);
  } finally {
    try { cdp?.close(); } catch {}
    try { ws?.close(); } catch {}
    try { proc?.kill(); } catch {}
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

export async function runAutomaticBrowserInteractionsForUrl(url: string, options: BrowserRuntimeOptions | undefined, evidence: BrowserEvidenceStoreLike | undefined, label = "interactions"): Promise<CheckOutcome> {
  return runCdpAutomaticSteps(url, options, evidence, label);
}

async function resolveBrowserStepsOutcome(input: RunBrowserChecksInput, probeAvailable: boolean): Promise<CheckOutcome> {
  const opts = input.options ?? {};
  const injected = normalizeScenarioExecution((opts as any).scenarioExecution);
  if (injected) return toScenarioOutcome(injected);
  const plan = resolveScenarioPlanInput(input);
  if (plan) {
    if ((input as any).scenarioPage) {
      try { return toScenarioOutcome(await executeScenarioPlan((input as any).scenarioPage, plan, input.evidence, opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs })); }
      catch (error) { return blockedBrowserOutcome({ id: "browser.steps", title: "Scenario steps" } as Check, `Scenario execution could not run: ${error instanceof Error ? error.message : String(error)}`); }
    }
    // explicit plan provided but no CDP page adapter wired for it yet: fall back to auto interactions on target URL
  }
  if (!probeAvailable) return blockedBrowserOutcome({ id: "browser.steps", title: "Scenario steps" } as Check, "Browser runtime is unavailable for scenario execution.");
  // Auto-run interaction exploration (clicks, forms, toggles, scrolls, navigation) by default
  return runCdpAutomaticSteps(input.url, opts, input.evidence, "auto-interactions");
}

export async function runBrowserChecks(input: RunBrowserChecksInput): Promise<void> {
  const { checks, onOutcome, options, evidence } = input;
  const viewportLabel = input.viewport ?? resolveBrowserViewport(options).label;
  const emit = async (check: Check, outcome: CheckOutcome): Promise<void> => { await onOutcome(check, applyViewportMetadata(outcome, viewportLabel)); };
  const hasSteps = checks.some((c) => c.id === "browser.steps");
  const nonSteps = checks.filter((c) => c.id !== "browser.steps");
  let stepsOutcome: CheckOutcome | null = null;
  if (hasSteps) { const injected = normalizeScenarioExecution((options as any)?.scenarioExecution); if (injected) stepsOutcome = toScenarioOutcome(injected); }
  const probe = await probeBrowserRuntime(options);
  if (!probe.available || !probe.playwright) {
    const reason = probe.reason ?? "Browser runtime is unavailable.";
    if (nonSteps.length > 0) await degradeBrowserChecks(nonSteps, reason, emit);
    if (hasSteps) {
      const out = stepsOutcome ?? (await resolveBrowserStepsOutcome(input, false));
      for (const check of checks.filter((c) => c.id === "browser.steps")) await emit(check, stepsOutcome ? stepsOutcome : (out.status === CheckStatus.BLOCKED ? out : blockedBrowserOutcome(check, reason)));
    } else if (nonSteps.length === 0) await degradeBrowserChecks(checks, reason, emit);
    return;
  }
  const defaultCapabilities: BrowserAdapterCapabilities = { navigation: true, screenshots: true, console: true, network: true, storage: false, viewport: true, crawl: true };
  const declaredCaps = input.browserCapabilities ?? (input.browserAdapter ? await Promise.resolve((input.browserAdapter as any).capabilities?.() ?? defaultCapabilities) : undefined);
  const capabilities: BrowserAdapterCapabilities = { ...defaultCapabilities, ...(declaredCaps && typeof declaredCaps === "object" ? declaredCaps : {}) } as any;
  const negotiationAdapter: BrowserAdapter = (input.browserAdapter as any) ?? { id: "chrome-cdp", version: "1.0.0", nativeVersion: null, capabilities: () => capabilities, dispatch: async () => ({ outcomes: new Map() }) };
  const negotiation = negotiateBrowserDispatch(negotiationAdapter, capabilities, checks, options as any);
  const replannedIds = new Set(negotiation.replanned_checks);
  for (const item of negotiation.plan) {
    if (item.action !== "replan_skip") continue;
    const check = checks.find((c) => c.id === item.check_id); if (!check) continue;
    const note = item.coverage_note || `Browser check '${check.id}' re-planned due to missing adapter channel(s).`;
    await emit(check, new CheckOutcome({ status: CheckStatus.SKIPPED, actual: note, evidence: [], findings: [], blocker: null, metadata: { limitation: note, coverage_note: note, replanned: true, missing_channels: item.missing_channels, adapter_id: negotiation.adapter.adapter_id, not_a_pass: true } }));
  }
  const dispatchChecks = checks.filter((c) => !replannedIds.has(c.id));
  if (dispatchChecks.length === 0) return;
  const dispatchHasSteps = dispatchChecks.some((c) => c.id === "browser.steps");
  const dispatchNonSteps = dispatchChecks.filter((c) => c.id !== "browser.steps");
  let views: BrowserPageView[] | null = null;
  if (dispatchNonSteps.length > 0 || (dispatchHasSteps && !stepsOutcome)) {
    if (Array.isArray(input.pageViews) && input.pageViews.length > 0) views = input.pageViews.map(normalizePageView);
    else if (Array.isArray(input.views) && input.views.length > 0) views = input.views.map(normalizePageView);
    else if (input.pageView) views = [normalizePageView(input.pageView)];
    else {
      try { views = await captureWithPlaywright(input.url, probe.playwright, options, evidence); }
      catch (error) { const reason = error instanceof BrowserUnavailableError ? error.reason : (error instanceof Error ? error.message : String(error)); await degradeBrowserChecks(dispatchChecks, reason, emit); return; }
    }
  }
  if ((dispatchNonSteps.length > 0) && (!views || views.length === 0)) { await degradeBrowserChecks(dispatchChecks, "No browser page view could be captured.", emit); return; }
  const multi = !!views && (views.length > 1 || (options?.crawl === true && resolveBrowserMaxPages(options) > 1));
  if (dispatchHasSteps && !stepsOutcome) stepsOutcome = await resolveBrowserStepsOutcome({ ...input, checks: dispatchChecks }, true);
  const findSourceScreenshotRef = (): string | null => { for (const v of views ?? []) { const ref = v?.evidenceRefs?.screenshot; if (typeof ref === "string" && ref) return ref; } return null; };
  const ensurePerCheckScreenshot = async (check: Check, outcome: CheckOutcome): Promise<void> => {
    if (!evidence || typeof (evidence as any).saveScreenshot !== "function") return;
    if (outcome.status === CheckStatus.BLOCKED) return;
    const hasCheckScreenshot = (outcome.evidence ?? []).some((r) => typeof r === "string" && r.includes(`/${check.id}/screenshot-`));
    if (hasCheckScreenshot) return;
    const srcRef = findSourceScreenshotRef(); if (!srcRef) return;
    const store: any = evidence as any; if (typeof store.readEvidenceArtifact !== "function") return;
    try {
      const art = await store.readEvidenceArtifact(srcRef); if (!art || !art.data) return;
      const checkRef = await store.saveScreenshot(`screenshot-${check.id}`, art.data, `Full-page screenshot for ${check.id}`, check.id);
      if (typeof checkRef === "string" && checkRef) outcome.evidence = [...(outcome.evidence ?? []), checkRef];
    } catch {}
  };
  for (const check of dispatchChecks) {
    try {
      if (check.id === "browser.steps") { await emit(check, stepsOutcome ?? blockedBrowserOutcome(check, "No scenario plan or execution was provided for browser.steps.")); continue; }
      if (!IMPLEMENTED_BROWSER_CHECKS.has(check.id)) { await emit(check, notImplementedOutcome(check)); continue; }
      if (!views || views.length === 0) { await emit(check, blockedBrowserOutcome(check, "No browser page view could be captured.")); continue; }
      const outcome = multi ? evaluateBrowserCheckAcrossViews(check, views) : evaluateBrowserCheckForCheck(check, views[0]!);
      await ensurePerCheckScreenshot(check, outcome);
      await emit(check, outcome);
    } catch (error) { await emit(check, blockedBrowserOutcome(check, `Browser check execution failed: ${error instanceof Error ? error.message : String(error)}`)); }
  }
}
