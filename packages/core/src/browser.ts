/**
 * Optional browser capability surface (contract/subpath).
 *
 * This subpath is optional and must not require Playwright for core installs.
 * Concrete browser automation lives in @lemma/browser (optional peer).
 */
export const BROWSER_SUBPATH = "@lemma/core/browser" as const;
export const BROWSER_OPTIONAL = true as const;

export interface BrowserCapabilityContract {
  readonly optional: true;
  readonly provider: "@lemma/browser";
}
