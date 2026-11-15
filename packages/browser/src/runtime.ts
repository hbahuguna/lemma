import {
  CheckOutcome,
  CheckStatus,
  type BlockerDraft,
  type Check,
} from "@lemma/core";

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

export type BrowserOutcomeCallback = (
  check: Check,
  outcome: CheckOutcome,
) => unknown;

export interface RunBrowserChecksInput {
  url: string;
  checks: readonly Check[];
  onOutcome: BrowserOutcomeCallback;
  options?: BrowserRuntimeOptions;
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

/**
 * Run browser checks with optional Playwright runtime. LEM-050 provides the
 * runtime probe/load and blocked degradation path; full check evaluators land in
 * later E5 tasks.
 *
 * - disabled/no-browser: degrades every check as blocked.
 * - runtime unavailable (missing Playwright/Chromium or failed probe): degrades
 *   every check as blocked with actionable blocker drafts.
 * - runtime available: throws a typed-unavailable error only until evaluators are
 *   wired; callers should treat this as not-yet-implemented in this slice. (This
 *   path is not required by LEM-050 ACs and will be replaced by LEM-051+.)
 */
export async function runBrowserChecks(input: RunBrowserChecksInput): Promise<void> {
  const { checks, onOutcome, options } = input;
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

  // Runtime is available but check evaluators/navigation are implemented in
  // subsequent E5 tasks (LEM-051+). Do not silently pass: block explicitly so a
  // future integration cannot misread this as executed coverage.
  const notImplemented =
    "Browser runtime is available but browser check evaluators are not implemented in this build slice.";
  await degradeBrowserChecks(checks, notImplemented, onOutcome);
}
