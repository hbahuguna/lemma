import { describe, expect, it } from "vitest";

import {
  ASSAY_COMMAND_CATALOG,
  buildCatalogInvocation,
  getAssayCommand,
  getCatalogCommandKind,
} from "../../src/index.js";

describe("LEM-148 bug-hunt catalog wiring", () => {
  it("exposes assay-hunt (lemma hunt) in the catalog with intent mapping", () => {
    const cmd = getAssayCommand("assay-hunt");
    expect(cmd).toEqual({ name: "assay-hunt", label: "hunt" });
    expect(ASSAY_COMMAND_CATALOG.some((c) => c.name === "assay-hunt" && c.label === "hunt")).toBe(true);
    expect(getCatalogCommandKind("assay-hunt")).toBe("static");

    const inv = buildCatalogInvocation("assay-hunt", "ignored", "personas");
    expect(inv).not.toBeNull();
    expect(inv?.intent).toBe("Assay hunt assessment");
    expect(inv?.kind).toBe("static");
    expect(inv?.invocation.args).toEqual([
      "run",
      "--target",
      ".",
      "--no-browser",
      "--personas-dir",
      "personas",
      "--intent",
      "Assay hunt assessment",
    ]);
  });
});
