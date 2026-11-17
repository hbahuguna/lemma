import { describe, expect, it } from "vitest";

import {
  ASSAY_COMMAND_CATALOG,
  assayIntent,
  buildCatalogInvocation,
  getAssayCommand,
  getCatalogCommandKind,
} from "../src/index.js";

const PERSONAS = "/tmp/personas";

describe("LEM-089 command catalog and intent mapping", () => {
  it("exports the canonical 60-command catalog in assay order with intent helpers", () => {
    expect(ASSAY_COMMAND_CATALOG).toHaveLength(60);
    expect(ASSAY_COMMAND_CATALOG[0]).toEqual({ name: "lemma-manager", label: "manager" });
    expect(ASSAY_COMMAND_CATALOG[4]).toEqual({ name: "lemma-browser", label: "browser" });
    expect(ASSAY_COMMAND_CATALOG[6]).toEqual({ name: "lemma-demo", label: "demo" });
    expect(ASSAY_COMMAND_CATALOG[58]).toEqual({ name: "lemma-pro", label: "pro" });
    expect(ASSAY_COMMAND_CATALOG[59]).toEqual({ name: "lemma-hunt", label: "hunt" });
    expect(getAssayCommand("assay-security-review")?.label).toBe("security-review");
    expect(getAssayCommand("nope")).toBeUndefined();
    expect(assayIntent("ui")).toBe("Lemma ui assessment");
  });

  it("maps browser command to URL-required live browser invocation semantics", () => {
    expect(getCatalogCommandKind("assay-browser")).toBe("browser");
    const missingUrl = buildCatalogInvocation("assay-browser", "", PERSONAS);
    expect(missingUrl?.kind).toBe("browser");
    expect(missingUrl?.intent).toBe("Lemma browser assessment");
    expect(missingUrl?.invocation.args).toEqual([]);
    expect(missingUrl?.invocation.error).toMatch(/needs a reachable URL/);

    const withUrl = buildCatalogInvocation("assay-browser", "http://localhost:3000", PERSONAS);
    expect(withUrl?.invocation.args[0]).toBe("browser");
    expect(withUrl?.invocation.args[1]).toBe("http://localhost:3000");
    expect(withUrl?.invocation.args).not.toContain("--no-browser");
    expect(withUrl?.invocation.args).not.toContain("run");
  });

  it("maps demo command to static inventory without URL and live browser with URL", () => {
    expect(getCatalogCommandKind("assay-demo")).toBe("demo");
    const staticDemo = buildCatalogInvocation("assay-demo", "", PERSONAS);
    expect(staticDemo?.kind).toBe("demo");
    expect(staticDemo?.intent).toBe("Lemma demo assessment");
    expect(staticDemo?.invocation.args).toEqual([
      "run",
      "--target",
      ".",
      "--no-browser",
      "--personas-dir",
      PERSONAS,
      "--intent",
      "Lemma demo assessment",
    ]);

    const liveDemo = buildCatalogInvocation("assay-demo", "http://localhost:3000", PERSONAS);
    expect(liveDemo?.invocation.args).not.toContain("--no-browser");
    expect(liveDemo?.invocation.args[liveDemo.invocation.args.indexOf("--target") + 1]).toBe("http://localhost:3000");
  });

  it("maps other catalog commands to deterministic static assessment runs", () => {
    const names = ["assay-manager", "assay-accessibility", "assay-full-report", "assay-pro", "assay-hunt"];
    for (const name of names) {
      expect(getCatalogCommandKind(name)).toBe("static");
      const result = buildCatalogInvocation(name, "ignored freeform text", PERSONAS);
      expect(result).not.toBeNull();
      expect(result?.kind).toBe("static");
      expect(result?.invocation.error).toBeUndefined();
      expect(result?.invocation.args).toEqual([
        "run",
        "--target",
        ".",
        "--no-browser",
        "--personas-dir",
        PERSONAS,
        "--intent",
        assayIntent(result!.command.label),
      ]);
    }
    expect(buildCatalogInvocation("assay-unknown", "", PERSONAS)).toBeNull();
  });
});
