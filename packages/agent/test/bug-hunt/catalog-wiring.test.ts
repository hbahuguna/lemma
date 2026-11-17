import { describe, expect, it } from "vitest";

import {
  ASSAY_COMMAND_CATALOG,
  buildCatalogInvocation,
  getAssayCommand,
  getCatalogCommandKind,
} from "../../src/index.js";

describe("LEM-148 bug-hunt catalog wiring", () => {
  it("exposes assay-hunt (lemma hunt) in the catalog with intent mapping", () => {
    const cmd = getAssayCommand("lemma-hunt");
    expect(cmd).toEqual({ name: "lemma-hunt", label: "hunt" });
    expect(ASSAY_COMMAND_CATALOG.some((c) => c.name === "lemma-hunt" && c.label === "hunt")).toBe(true);
    expect(getCatalogCommandKind("lemma-hunt")).toBe("static");

    const inv = buildCatalogInvocation("lemma-hunt", "ignored", "personas");
    expect(inv).not.toBeNull();
    expect(inv?.intent).toBe("Lemma hunt assessment");
    expect(inv?.kind).toBe("static");
    expect(inv?.invocation.args).toEqual([
      "run",
      "--target",
      ".",
      "--no-browser",
      "--personas-dir",
      "personas",
      "--intent",
      "Lemma hunt assessment",
    ]);
  });
});
