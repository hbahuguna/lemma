import {
  CheckOutcome,
  CheckStatus,
  type BlockerDraft,
  type Check,
} from "@lemma/core";

import {
  IMPLEMENTED_BROWSER_CHECKS,
  evaluateBrowserCheckForCheck,
  normalizePageView,
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
async function captureWithPlaywright(
  url: string,
  playwright: PlaywrightModuleLike,
  options: BrowserRuntimeOptions | undefined,
  evidence?: BrowserEvidenceStoreLike,
): Promise<BrowserPageView> {
  const chromium = playwright.chromium;
  if (!chromium || typeof chromium.launch !== "function") {
    throw new BrowserUnavailableError("Playwright Chromium launcher is unavailable.");
  }
  const headless = options?.headless ?? true;
  const timeoutMs = options?.timeoutMs ?? 30000;
  const browser = await chromium.launch({ headless }) as {
    newContext: (opts?: Record<string, unknown>) => Promise<{
      newPage: () => Promise<any>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const consoleMessages: Array<Record<string, unknown>> = [];
  const pageErrors: Array<Record<string, unknown>> = [];
  const networkEntries: Array<Record<string, unknown>> = [];
  const navigation: { url: string; finalUrl: string; status?: number | null; headers?: Record<string, string>; error?: string } = {
    url,
    finalUrl: url,
  };
  const evidenceRefs: Record<string, string> = {};

  page.on?.("console", (msg: any) => {
    try {
      consoleMessages.push({ type: msg.type?.() ?? "log", text: String(msg.text?.() ?? "") });
    } catch {
      // ignore console capture errors
    }
  });
  page.on?.("pageerror", (err: any) => {
    pageErrors.push({ text: String(err?.message ?? err ?? "page error") });
  });
  page.on?.("requestfailed", (req: any) => {
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
  });
  page.on?.("response", (res: any) => {
    try {
      networkEntries.push({
        url: String(res.url?.() ?? ""),
        status: typeof res.status === "function" ? res.status() : undefined,
        failed: false,
      });
    } catch {
      // ignore
    }
  });

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
          const h1s = Array.from(doc?.querySelectorAll?.("h1") ?? []).map((n: any) =>
            String(n?.innerText ?? n?.textContent ?? "").trim(),
          ).filter((t: string) => t.length > 0);
          const links = Array.from(doc?.querySelectorAll?.("a") ?? []).map((a: any, i: number) => ({
            selector: `a:nth-of-type(${i + 1})`,
            href: String(a?.getAttribute?.("href") ?? ""),
            target: String(a?.getAttribute?.("target") ?? ""),
            rel: String(a?.getAttribute?.("rel") ?? ""),
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

    if (evidence) {
      try {
        evidenceRefs.navigation = await evidence.saveJson(
          "navigation",
          navigation,
          "navigation",
          "Browser navigation result",
        );
        evidenceRefs.snapshot = await evidence.saveJson(
          "dom-snapshot",
          snapshot,
          "dom_snapshot",
          "Captured DOM snapshot",
        );
        evidenceRefs.console = await evidence.saveJson(
          "console-log",
          [...consoleMessages, ...pageErrors.map((e) => ({ type: "pageerror", ...e }))],
          "console_log",
          "Browser console and page errors",
        );
        evidenceRefs.network = await evidence.saveJson(
          "network-log",
          networkEntries,
          "network_log",
          "Browser network entries",
        );
      } catch {
        // evidence capture must not fail the check run
      }
      try {
        if (typeof page.screenshot === "function" && evidence.saveScreenshot) {
          const shot = await page.screenshot({ fullPage: true });
          if (shot) {
            evidenceRefs.screenshot = await evidence.saveScreenshot(
              "landing-page",
              shot as Uint8Array | Buffer,
              "Landing page screenshot",
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
      label: "landing",
    });
  } finally {
    try {
      await context.close();
    } catch {
      // ignore
    }
    try {
      await browser.close();
    } catch {
      // ignore
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

function outcomeForUnsupported(check: Check): CheckOutcome {
  return notImplementedOutcome(check);
}

async function emitCheckOutcome(
  check: Check,
  view: BrowserPageView,
  onOutcome: BrowserOutcomeCallback,
): Promise<void> {
  if (!IMPLEMENTED_BROWSER_CHECKS.has(check.id)) {
    await onOutcome(check, outcomeForUnsupported(check));
    return;
  }
  await onOutcome(check, evaluateBrowserCheckForCheck(check, view));
}

/**
 * Run browser checks with optional Playwright runtime.
 *
 * - disabled/no-browser or unavailable runtime: degrade every check as blocked
 *   (LEM-050 contract).
 * - runtime available: evaluate implemented checks (load/console/network/content/
 *   links) from injected or captured observations; degrade unimplemented browser
 *   checks as blocked "not implemented in this slice".
 */
export async function runBrowserChecks(input: RunBrowserChecksInput): Promise<void> {
  const { url, checks, onOutcome, options, pageView, evidence } = input;
  const disabled = browserDisabledReason(options);
  if (disabled) {
    await degradeBrowserChecks(checks, disabled, onOutcome);
    return;
  }
  const probe = await probeBrowserRuntime(options);
  if (!probe.available) {
    await degradeBrowserChecks(
      checks,
      probe.reason ?? "Playwright/Chromium runtime is unavailable.",
      onOutcome,
    );
    return;
  }

  let view: BrowserPageView;
  if (pageView) {
    view = normalizePageView(pageView);
  } else {
    try {
      view = await captureWithPlaywright(url, probe.playwright as PlaywrightModuleLike, options, evidence);
    } catch (error) {
      const reason =
        error instanceof BrowserUnavailableError
          ? error.reason
          : error instanceof Error
            ? error.message
            : String(error);
      // If capture/start itself failed after probe, treat as blocked runtime/capture failure.
      await degradeBrowserChecks(checks, `Browser checks were not executed: ${reason}`, onOutcome);
      return;
    }
  }

  for (const check of checks) {
    await emitCheckOutcome(check, view, onOutcome);
  }
}
