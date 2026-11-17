import { createRequire } from "node:module";

import {
  dispatchWithBrowserAdapter,
  negotiateBrowserDispatch,
  type BrowserAdapter,
  type BrowserAdapterCapabilities,
  type BrowserDispatchRequest,
  type BrowserDispatchResult,
  type Check,
  type CheckOutcome,
} from "@lemma/core";

import {
  degradeBrowserChecks,
  probeBrowserRuntime,
  type BrowserEvidenceStoreLike,
  type BrowserRuntimeOptions,
  type RunBrowserChecksInput,
} from "./runtime.js";
import type { BrowserPageView } from "./checks.js";

function resolvePlaywrightNativeVersion(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("playwright/package.json") as { version?: string } | undefined;
    return typeof pkg?.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export const PLAYWRIGHT_BROWSER_CAPABILITIES: BrowserAdapterCapabilities = {
  navigation: true,
  screenshots: true,
  console: true,
  network: true,
  storage: true,
  viewport: true,
  crawl: true,
};

export interface PlaywrightBrowserAdapterOptions extends BrowserRuntimeOptions {
  /** Override declared capabilities (e.g. simulate missing channels for tests/re-plan). */
  declaredCapabilities?: Partial<BrowserAdapterCapabilities>;
  /** Injectable dispatch handler (tests). */
  dispatchHandler?: (request: BrowserDispatchRequest & { runtimeOptions?: BrowserRuntimeOptions; evidence?: BrowserEvidenceStoreLike; views?: BrowserPageView[] }) => Promise<BrowserDispatchResult>;
}

export class PlaywrightBrowserAdapter implements BrowserAdapter {
  readonly id = "playwright";
  readonly version = "1.0.0";
  readonly nativeVersion: string | null;
  private readonly options: PlaywrightBrowserAdapterOptions;

  constructor(options: PlaywrightBrowserAdapterOptions = {}) {
    this.options = options;
    this.nativeVersion = resolvePlaywrightNativeVersion();
  }

  capabilities(): BrowserAdapterCapabilities {
    return { ...PLAYWRIGHT_BROWSER_CAPABILITIES, ...(this.options.declaredCapabilities ?? {}) };
  }

  async probe(options?: Record<string, unknown>): Promise<{ available: boolean; reason?: string }> {
    const merged = { ...this.options, ...(options ?? {}) } as BrowserRuntimeOptions;
    const p = await probeBrowserRuntime(merged);
    return p.available ? { available: true } : { available: false, reason: p.reason ?? "Browser runtime is unavailable." };
  }

  async dispatch(request: BrowserDispatchRequest): Promise<BrowserDispatchResult> {
    const runtimeOptions = { ...this.options, ...(request.options ?? {}) } as BrowserRuntimeOptions;
    const evidence = (request as any).evidence as BrowserEvidenceStoreLike | undefined;
    const onOutcome = (request as any).onOutcome as ((check: Check, outcome: CheckOutcome) => unknown) | undefined;

    if (this.options.dispatchHandler) {
      return this.options.dispatchHandler({ ...(request as any), runtimeOptions, ...(evidence ? { evidence } : {}) });
    }

    // Reuse runtime capture+evaluation flow for requested checks.
    const outcomes = new Map<string, CheckOutcome>();
    const checks = [...request.checks] as Check[];

    // blocked runtime behavior preserved: if runtime unavailable, block all dispatched checks
    const probe = await probeBrowserRuntime(runtimeOptions);
    if (!probe.available || !probe.playwright) {
      const reason = probe.reason ?? "Browser runtime is unavailable.";
      await degradeBrowserChecks(checks, reason, async (check, outcome) => { outcomes.set(check.id, outcome); if (onOutcome) await onOutcome(check, outcome); });
      return { outcomes, blocked_runtime: true, blocked_reason: reason };
    }

    // If caller provided injected views/pageView/scenario context, delegate to runBrowserChecks-like behavior by capturing or using injections via request
    const input: RunBrowserChecksInput = {
      url: request.url,
      checks,
      options: runtimeOptions,
      ...(evidence ? { evidence } : {}),
      ...(request as any).pageView ? { pageView: (request as any).pageView } : {},
      ...(request as any).pageViews ? { pageViews: (request as any).pageViews } : {},
      ...(request as any).views ? { views: (request as any).views } : {},
      ...(request as any).scenarioPage ? { scenarioPage: (request as any).scenarioPage } : {},
      onOutcome: async (check, outcome) => {
        outcomes.set(check.id, outcome);
        if (onOutcome) await onOutcome(check, outcome);
      },
    };

    // Defer to runtime implementation for capture/evaluation to preserve behavior
    const { runBrowserChecks } = await import("./runtime.js");
    await runBrowserChecks(input);
    return { outcomes, blocked_runtime: false };
  }
}

export function createPlaywrightBrowserAdapter(options: PlaywrightBrowserAdapterOptions = {}): PlaywrightBrowserAdapter {
  return new PlaywrightBrowserAdapter(options);
}

export { dispatchWithBrowserAdapter, negotiateBrowserDispatch };
