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
  { name: "assay-manager", label: "manager" },
  { name: "assay-full", label: "full" },
  { name: "assay-test", label: "test" },
  { name: "assay-functionality", label: "functionality" },
  { name: "assay-browser", label: "browser" },
  { name: "assay-issues", label: "issues" },
  { name: "assay-demo", label: "demo" },
  { name: "assay-more", label: "more" },
  { name: "assay-help", label: "help" },
  { name: "assay-accessibility", label: "accessibility" },
  { name: "assay-ui", label: "ui" },
  { name: "assay-ux", label: "ux" },
  { name: "assay-usability", label: "usability" },
  { name: "assay-personas", label: "personas" },
  { name: "assay-compatibility", label: "compatibility" },
  { name: "assay-intl", label: "intl" },
  { name: "assay-localization", label: "localization" },
  { name: "assay-content", label: "content" },
  { name: "assay-geo", label: "geo" },
  { name: "assay-security", label: "security" },
  { name: "assay-security-review", label: "security-review" },
  { name: "assay-privacy", label: "privacy" },
  { name: "assay-state", label: "state" },
  { name: "assay-reliability", label: "reliability" },
  { name: "assay-performance", label: "performance" },
  { name: "assay-load", label: "load" },
  { name: "assay-stress", label: "stress" },
  { name: "assay-networking", label: "networking" },
  { name: "assay-api", label: "api" },
  { name: "assay-data", label: "data" },
  { name: "assay-failure", label: "failure" },
  { name: "assay-proof", label: "proof" },
  { name: "assay-confidence", label: "confidence" },
  { name: "assay-confidence-init", label: "confidence-init" },
  { name: "assay-confidence-plan", label: "confidence-plan" },
  { name: "assay-review", label: "review" },
  { name: "assay-skeptical-review", label: "skeptical-review" },
  { name: "assay-release", label: "release" },
  { name: "assay-release-review", label: "release-review" },
  { name: "assay-incident", label: "incident" },
  { name: "assay-eval", label: "eval" },
  { name: "assay-eval-design-review", label: "eval-design-review" },
  { name: "assay-statistical-review", label: "statistical-review" },
  { name: "assay-agentic", label: "agentic" },
  { name: "assay-chatbot", label: "chatbot" },
  { name: "assay-bias", label: "bias" },
  { name: "assay-tests", label: "tests" },
  { name: "assay-generate", label: "generate" },
  { name: "assay-map", label: "map" },
  { name: "assay-full-report", label: "full-report" },
  { name: "assay-stats", label: "stats" },
  { name: "assay-integrations", label: "integrations" },
  { name: "assay-ai-upgrade", label: "ai-upgrade" },
  { name: "assay-auto", label: "auto" },
  { name: "assay-background", label: "background" },
  { name: "assay-forever", label: "forever" },
  { name: "assay-settings", label: "settings" },
  { name: "assay-human", label: "human" },
  { name: "assay-pro", label: "pro" },
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
      "run",
      "--target",
      "http://localhost:3000",
      "--personas-dir",
      PERSONAS,
      "--intent",
      "Assay browser assessment",
      "--crawl",
      "--max-pages",
      "8",
      "--mobile",
      "--headed",
      "--active",
      "--active-interactions",
    ]);
    expect(live.args).not.toContain("--no-browser");

    const overridden = browserInvocation(
      "http://localhost:3000 --no-crawl --max-pages 3 --no-mobile --headless",
      PERSONAS,
    );
    expect(overridden.args).toContain("--no-crawl");
    expect(overridden.args[overridden.args.indexOf("--max-pages") + 1]).toBe("3");
    expect(overridden.args).toContain("--no-mobile");
    expect(overridden.args).toContain("--headless");
    expect(overridden.args).not.toContain("--crawl");
    expect(overridden.args).not.toContain("--mobile");
    expect(overridden.args).not.toContain("--headed");

    const passthrough = browserInvocation(
      "http://localhost:3000 --headed --mobile --viewport 390x844 --no-browser --target https://evil.example",
      PERSONAS,
    );
    expect(passthrough.args).toContain("--viewport");
    expect(passthrough.args[passthrough.args.indexOf("--viewport") + 1]).toBe("390x844");
    expect(passthrough.args).toContain("--headed");
    expect(passthrough.args).toContain("--mobile");
    expect(passthrough.args).toContain("--active");
    expect(passthrough.args).toContain("--active-interactions");
    expect(passthrough.args).not.toContain("--no-browser");
    expect(passthrough.args.filter((arg) => arg === "--target")).toHaveLength(1);
    expect(passthrough.args[passthrough.args.indexOf("--target") + 1]).toBe("http://localhost:3000");
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
      "Assay demo assessment",
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

  it("catalog exposes canonical 59 commands in assay order with intent/kind parity", () => {
    expect(ASSAY_COMMAND_CATALOG).toHaveLength(59);
    expect(ASSAY_COMMAND_CATALOG.map((c) => ({ name: c.name, label: c.label }))).toEqual(EXPECTED_CATALOG);
    expect(getAssayCommand("assay-security-review")).toEqual({
      name: "assay-security-review",
      label: "security-review",
    });
    expect(getAssayCommand("assay-unknown")).toBeUndefined();
    expect(assayIntent("ui")).toBe("Assay ui assessment");
    expect(getCatalogCommandKind("assay-browser")).toBe("browser");
    expect(getCatalogCommandKind("assay-demo")).toBe("demo");
    expect(getCatalogCommandKind("assay-manager")).toBe("static");
  });

  it("catalog invocation mapping is deterministic and loop-facing builders stay consistent", () => {
    const browserMissing = buildCatalogInvocation("assay-browser", "", PERSONAS);
    expect(browserMissing?.kind).toBe("browser");
    expect(browserMissing?.intent).toBe("Assay browser assessment");
    expect(browserMissing?.invocation.args).toEqual([]);
    expect(browserMissing?.invocation.error).toMatch(/needs a reachable URL/);

    const browserLive = buildCatalogInvocation("assay-browser", "http://localhost:3000", PERSONAS);
    expect(browserLive?.invocation.args).not.toContain("--no-browser");
    expect(browserLive?.invocation.args[browserLive.invocation.args.indexOf("--target") + 1]).toBe(
      "http://localhost:3000",
    );

    const demoStatic = buildCatalogInvocation("assay-demo", "", PERSONAS);
    expect(demoStatic?.kind).toBe("demo");
    expect(demoStatic?.intent).toBe("Assay demo assessment");
    expect(demoStatic?.invocation.args).toEqual([
      "run",
      "--target",
      ".",
      "--no-browser",
      "--personas-dir",
      PERSONAS,
      "--intent",
      "Assay demo assessment",
    ]);

    const demoLive = buildCatalogInvocation("assay-demo", "http://localhost:3000", PERSONAS);
    expect(demoLive?.invocation.args).not.toContain("--no-browser");
    expect(demoLive?.invocation.args[demoLive.invocation.args.indexOf("--target") + 1]).toBe(
      "http://localhost:3000",
    );

    for (const cmd of ASSAY_COMMAND_CATALOG) {
      if (cmd.name === "assay-browser" || cmd.name === "assay-demo") continue;
      const mapped = buildCatalogInvocation(cmd.name, "ignored freeform text", PERSONAS);
      expect(mapped).not.toBeNull();
      expect(mapped?.kind).toBe("static");
      expect(mapped?.intent).toBe(`Assay ${cmd.label} assessment`);
      expect(mapped?.invocation.args).toEqual([
        "run",
        "--target",
        ".",
        "--no-browser",
        "--personas-dir",
        PERSONAS,
        "--intent",
        `Assay ${cmd.label} assessment`,
      ]);
    }
    expect(buildCatalogInvocation("assay-unknown", "", PERSONAS)).toBeNull();

    expect(commandToArgs("assay-browser http://localhost:3000", PERSONAS)).toMatchObject({
      args: browserLive?.invocation.args,
    });
    expect(commandToArgs("assay-demo", PERSONAS)).toMatchObject({ args: demoStatic?.invocation.args });
    expect(commandToArgs("assay status --root .harness", PERSONAS)).toEqual({ args: ["status", "--root", ".harness"] });
  });
});
