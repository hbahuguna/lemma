/**
 * @lemma/browser — Optional Playwright-backed Operate layer.
 *
 * LEM-050: optional runtime loading and blocked degradation. Browser checks are
 * blocked with actionable blockers when Playwright/Chromium is unavailable or the
 * browser runtime is disabled; this never fails the run.
 */

export * from "./runtime.js";
