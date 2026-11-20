import { describe, expect, it } from "vitest";

import {
  ASSAY_COMMAND_CATALOG,
  SUBCOMMANDS,
  assayIntent,
  assayInvocation,
  browserInvocation,
  buildCatalogInvocation,
  commandToArgs,
  demoInvocation,
  extractUrl,
  getAssayCommand,
  getCatalogCommandKind,
  isUrl,
} from "../src/index.js";

const PERSONAS = "/tmp/personas";

const EXPECTED_CATALOG: ReadonlyArray<{ name: string; label: string }> = [
  { name: "lemma-manager", label: "manager" },
  { name: "lemma-full", label: "full" },
  { name: "lemma-test", label: "test" },
  { name: "lemma-functionality", label: "functionality" },
  { name: "lemma-browser", label: "browser" },
  { name: "lemma-issues", label: "issues" },
  { name: "lemma-demo", label: "demo" },
  { name: "lemma-more", label: "more" },
  { name: "lemma-help", label: "help" },
  { name: "lemma-accessibility", label: "accessibility" },
  { name: "lemma-ui", label: "ui" },
  { name: "lemma-ux", label: "ux" },
  { name: "lemma-usability", label: "usability" },
  { name: "lemma-personas", label: "personas" },
  { name: "lemma-compatibility", label: "compatibility" },
  { name: "lemma-intl", label: "intl" },
  { name: "lemma-localization", label: "localization" },
  { name: "lemma-content", label: "content" },
  { name: "lemma-geo", label: "geo" },
  { name: "lemma-security", label: "security" },
  { name: "lemma-security-review", label: "security-review" },
  { name: "lemma-privacy", label: "privacy" },
  { name: "lemma-state", label: "state" },
  { name: "lemma-reliability", label: "reliability" },
  { name: "lemma-performance", label: "performance" },
  { name: "lemma-load", label: "load" },
  { name: "lemma-stress", label: "stress" },
  { name: "lemma-networking", label: "networking" },
  { name: "lemma-api", label: "api" },
  { name: "lemma-data", label: "data" },
  { name: "lemma-failure", label: "failure" },
  { name: "lemma-proof", label: "proof" },
  { name: "lemma-confidence", label: "confidence" },
  { name: "lemma-confidence-init", label: "confidence-init" },
  { name: "lemma-confidence-plan", label: "confidence-plan" },
  { name: "lemma-review", label: "review" },
  { name: "lemma-skeptical-review", label: "skeptical-review" },
  { name: "lemma-release", label: "release" },
  { name: "lemma-release-review", label: "release-review" },
  { name: "lemma-incident", label: "incident" },
  { name: "lemma-eval", label: "eval" },
  { name: "lemma-eval-design-review", label: "eval-design-review" },
  { name: "lemma-statistical-review", label: "statistical-review" },
  { name: "lemma-agentic", label: "agentic" },
  { name: "lemma-chatbot", label: "chatbot" },
  { name: "lemma-bias", label: "bias" },
  { name: "lemma-tests", label: "tests" },
  { name: "lemma-generate", label: "generate" },
  { name: "lemma-map", label: "map" },
  { name: "lemma-full-report", label: "full-report" },
  { name: "lemma-stats", label: "stats" },
  { name: "lemma-integrations", label: "integrations" },
  { name: "lemma-ai-upgrade", label: "ai-upgrade" },
  { name: "lemma-auto", label: "auto" },
  { name: "lemma-background", label: "background" },
  { name: "lemma-forever", label: "forever" },
  { name: "lemma-settings", label: "settings" },
  { name: "lemma-human", label: "human" },
  { name: "lemma-pro", label: "pro" },
  { name: "lemma-hunt", label: "hunt" },
];

describe("LEM-095 command-builder and catalog parity", () => {
  it("provides URL extraction/validation and known harness subcommand coverage", () => {
    expect(extractUrl("please check https://example.com/app?x=1 now")).toBe("https://example.com/app?x=1");
    expect(extractUrl("no url here")).toBeNull();
    expect(isUrl("http://localhost:3000")).toBe(true);
    expect(isUrl("https://example.com")).toBe(true);
    expect(isUrl("ftp://example.com")).toBe(false);
    expect(isUrl(".")).toBe(false);

    for (const cmd of [
      "run",
      "status",
      "report",
      "abort",
      "personas",
      "verify-evidence",
      "prune",
      "sarif",
      "junit",
      "sign-report",
      "verify-report",
    ]) {
      expect(SUBCOMMANDS.has(cmd)).toBe(true);
    }
  });

  it("browserInvocation requires reachable http(s) URL and builds live runs with defaults/overrides/passthrough", () => {
    const empty = browserInvocation("", PERSONAS);
    expect(empty.args).toEqual([]);
    expect(empty.error).toMatch(/needs a reachable URL/);

    const dirOnly = browserInvocation("./my-app", PERSONAS);
    expect(dirOnly.args).toEqual([]);
    expect(dirOnly.error).toBeTruthy();

    const live = browserInvocation("http://localhost:3000", PERSONAS);
    expect(live.error).toBeUndefined();
    expect(live.args).toEqual([
      "browser",
      "http://localhost:3000",
      "--crawl",
      "--max-pages",
      "80",
      "--timeout-ms",
      "120000",
    ]);
    expect(live.args).not.toContain("run");
    expect(live.args).not.toContain("--no-browser");
    expect(live.args).not.toContain("--headless");

    const overridden = browserInvocation(
      "http://localhost:3000 --no-crawl --max-pages 3 --no-mobile --headless",
      PERSONAS,
    );
    expect(overridden.args).toContain("--no-crawl");
    expect(overridden.args[overridden.args.lastIndexOf("--max-pages") + 1]).toBe("3");
    expect(overridden.args).toContain("--no-mobile");
    expect(overridden.args).toContain("--headless");
    expect(overridden.args).not.toContain("--crawl");
    expect(overridden.args).not.toContain("--mobile");
    expect(overridden.args).not.toContain("--headed");
    expect(overridden.args[0]).toBe("browser");

    const passthrough = browserInvocation(
      "http://localhost:3000 --headed --mobile --viewport 390x844 --no-browser --target https://evil.example",
      PERSONAS,
    );
    expect(passthrough.args).toContain("--viewport");
    expect(passthrough.args[passthrough.args.indexOf("--viewport") + 1]).toBe("390x844");
    expect(passthrough.args).toContain("--headed");
    expect(passthrough.args).toContain("--mobile");
    expect(passthrough.args).not.toContain("--active");
    expect(passthrough.args).not.toContain("--active-interactions");
    expect(passthrough.args).not.toContain("--no-browser");
    expect(passthrough.args.filter((arg) => arg === "browser")).toHaveLength(1);
    expect(passthrough.args).not.toContain("--target");
    expect(passthrough.args).not.toContain("https://evil.example");
  });

  it("demoInvocation and assayInvocation follow ported static/live/passthrough semantics", () => {
    const demoStatic = demoInvocation("", PERSONAS);
    expect(demoStatic.args).toEqual([
      "run",
      "--target",
      ".",
      "--no-browser",
      "--personas-dir",
      PERSONAS,
      "--intent",
      "Lemma demo assessment",
    ]);

    const demoLive = demoInvocation("http://localhost:3000 --no-crawl --headless", PERSONAS);
    expect(demoLive.args[demoLive.args.indexOf("--target") + 1]).toBe("http://localhost:3000");
    expect(demoLive.args).not.toContain("--no-browser");
    expect(demoLive.args).toContain("--no-crawl");
    expect(demoLive.args).toContain("--headless");
    expect(demoLive.args).not.toContain("--crawl");
    expect(demoLive.args).not.toContain("--headed");

    const urlRun = assayInvocation("check https://example.com", PERSONAS);
    expect(urlRun.args).not.toContain("--no-browser");
    expect(urlRun.args[urlRun.args.indexOf("--target") + 1]).toBe("https://example.com");
    expect(urlRun.args).toContain("--intent");

    const staticDefault = assayInvocation("review release readiness", PERSONAS);
    expect(staticDefault.args).toContain("--no-browser");
    expect(staticDefault.args[staticDefault.args.indexOf("--target") + 1]).toBe(".");

    expect(assayInvocation("status --root .harness", PERSONAS).args).toEqual(["status", "--root", ".harness"]);
    expect(assayInvocation("help", PERSONAS).args).toEqual(["--help"]);
    expect(assayInvocation("--help", PERSONAS).args).toEqual(["--help"]);
    expect(assayInvocation("--version", PERSONAS).args).toEqual(["--version"]);
  });

  it("catalog exposes canonical 60 commands in assay order with intent/kind parity", () => {
    expect(ASSAY_COMMAND_CATALOG).toHaveLength(60);
    expect(ASSAY_COMMAND_CATALOG.map((c) => ({ name: c.name, label: c.label }))).toEqual(EXPECTED_CATALOG);
    expect(getAssayCommand("lemma-security-review")).toEqual({
      name: "lemma-security-review",
      label: "security-review",
    });
    expect(getAssayCommand("lemma-unknown")).toBeUndefined();
    expect(assayIntent("ui")).toBe("Lemma ui assessment");
    expect(getCatalogCommandKind("lemma-browser")).toBe("browser");
    expect(getCatalogCommandKind("lemma-demo")).toBe("demo");
    expect(getCatalogCommandKind("lemma-manager")).toBe("static");
    expect(getCatalogCommandKind("lemma-hunt")).toBe("static");
  });

  it("catalog invocation mapping is deterministic and loop-facing builders stay consistent", () => {
    const browserMissing = buildCatalogInvocation("lemma-browser", "", PERSONAS);
    expect(browserMissing?.kind).toBe("browser");
    expect(browserMissing?.intent).toBe("Lemma browser assessment");
    expect(browserMissing?.invocation.args).toEqual([]);
    expect(browserMissing?.invocation.error).toMatch(/needs a reachable URL/);

    const browserLive = buildCatalogInvocation("lemma-browser", "http://localhost:3000", PERSONAS);
    expect(browserLive?.invocation.args).not.toContain("--no-browser");
    expect(browserLive?.invocation.args[0]).toBe("browser");
    expect(browserLive?.invocation.args[1]).toBe("http://localhost:3000");

    const demoStatic = buildCatalogInvocation("lemma-demo", "", PERSONAS);
    expect(demoStatic?.kind).toBe("demo");
    expect(demoStatic?.intent).toBe("Lemma demo assessment");
    expect(demoStatic?.invocation.args).toEqual([
      "run",
      "--target",
      ".",
      "--no-browser",
      "--personas-dir",
      PERSONAS,
      "--intent",
      "Lemma demo assessment",
    ]);

    const demoLive = buildCatalogInvocation("lemma-demo", "http://localhost:3000", PERSONAS);
    expect(demoLive?.invocation.args).not.toContain("--no-browser");
    expect(demoLive?.invocation.args[demoLive.invocation.args.indexOf("--target") + 1]).toBe(
      "http://localhost:3000",
    );

    for (const cmd of ASSAY_COMMAND_CATALOG) {
      if (cmd.name === "lemma-browser" || cmd.name === "lemma-demo") continue;
      const mapped = buildCatalogInvocation(cmd.name, "ignored freeform text", PERSONAS);
      expect(mapped).not.toBeNull();
      expect(mapped?.kind).toBe("static");
      expect(mapped?.intent).toBe(`Lemma ${cmd.label} assessment`);
      expect(mapped?.invocation.args).toEqual([
        "run",
        "--target",
        ".",
        "--no-browser",
        "--personas-dir",
        PERSONAS,
        "--intent",
        `Lemma ${cmd.label} assessment`,
      ]);
    }
    expect(buildCatalogInvocation("lemma-unknown", "", PERSONAS)).toBeNull();

    expect(commandToArgs("lemma-browser http://localhost:3000", PERSONAS)).toMatchObject({
      args: browserLive?.invocation.args,
    });
    expect(commandToArgs("lemma-demo", PERSONAS)).toMatchObject({ args: demoStatic?.invocation.args });
    expect(commandToArgs("assay status --root .harness", PERSONAS)).toEqual({ args: ["status", "--root", ".harness"] });
  });
});
