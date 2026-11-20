import { describe, expect, it } from "vitest";

import { isBrowserErrorUrl } from "../src/runtime.js";

describe("runtime navigation classification", () => {
  it("classifies browser error pages as coverage gaps, not target documents", () => {
    expect(isBrowserErrorUrl("chrome-error://chromewebdata/")).toBe(true);
    expect(isBrowserErrorUrl("about:blank")).toBe(true);
    expect(isBrowserErrorUrl("https://the-internet.herokuapp.com/accessibility_issues")).toBe(false);
  });
});
