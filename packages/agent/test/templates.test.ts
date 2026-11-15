import { describe, expect, it } from "vitest";

import { ASSAY_COMMAND_CATALOG, CONTEXT_PROTOCOL, buildBrowserAgentPrompt } from "../src/index.js";
import {
  renderAllCatalogCommandTemplates,
  renderCatalogCommandTemplate,
  renderLemmaSkillTemplate,
  renderOperationalCommandTemplate,
  renderPromptTemplates,
} from "../src/templates.js";

describe("LEM-106 shared prompt/skill/command templates", () => {
  it("renders deterministic catalog command templates with mode semantics", () => {
    const all = renderAllCatalogCommandTemplates({ cli: "lemma", personasDir: "./personas" });
    expect(all).toHaveLength(ASSAY_COMMAND_CATALOG.length);

    const browser = renderCatalogCommandTemplate("assay-browser", { cli: "lemma", personasDir: "./personas" });
    expect(browser?.kind).toBe("browser");
    expect(browser?.markdown).toContain("description: Run quality-harness live browser assessment (requires a URL)");
    expect(browser?.markdown).toContain("Require a reachable `http(s)` URL");
    expect(browser?.markdown).toContain(CONTEXT_PROTOCOL.split("\n")[0] ?? "Use OpenCode");
    expect(browser?.markdown).not.toContain("/Users/");

    const demo = renderCatalogCommandTemplate("assay-demo", { cli: "lemma", personasDir: "./personas" });
    expect(demo?.kind).toBe("demo");
    expect(demo?.markdown).toContain("If no URL is provided");
    expect(demo?.markdown).toContain("static");
    expect(demo?.markdown).toContain("live browser");
    expect(demo?.markdown).toContain("--no-browser");

    const security = renderCatalogCommandTemplate("assay-security", { cli: "lemma", personasDir: "./personas" });
    expect(security?.kind).toBe("static");
    expect(security?.markdown).toContain("Assay security assessment");
    expect(security?.markdown).toContain("```bash");
    expect(security?.markdown).toContain("lemma run --target . --no-browser --personas-dir ./personas --intent");
    expect(security?.markdown).toContain("Assay security assessment");
  });

  it("renders key operational command templates", () => {
    const status = renderOperationalCommandTemplate("assay-status", { cli: "lemma", stateRoot: ".lemma" });
    expect(status.kind).toBe("operational");
    expect(status.markdown).toContain("lemma status --root .lemma");

    const report = renderOperationalCommandTemplate("assay-report", { cli: "lemma", stateRoot: ".lemma" });
    expect(report.markdown).toContain("lemma report --root .lemma");

    const abort = renderOperationalCommandTemplate("assay-abort", { cli: "lemma", stateRoot: ".lemma" });
    expect(abort.markdown).toContain("lemma abort --root .lemma");

    const verify = renderOperationalCommandTemplate("assay-verify-evidence", { cli: "lemma", stateRoot: ".lemma" });
    expect(verify.markdown).toContain("lemma verify-evidence --root .lemma");

    const generic = renderOperationalCommandTemplate("assay", { cli: "lemma", personasDir: "./personas", stateRoot: ".lemma" });
    expect(generic.markdown).toContain("shared command builders/catalog");
  });

  it("reuses prompt primitives and renders skill template with core guidance", () => {
    const prompts = renderPromptTemplates();
    expect(prompts.contextProtocol).toBe(CONTEXT_PROTOCOL);
    const input = {
      url: "https://example.com",
      args: ["run", "--target", "https://example.com", "--browser"],
      projectDirectory: "/repo",
      repoRoot: "/repo",
      python: "python3",
      ssrfAllowlist: "127.0.0.0/8,::1,localhost",
    };
    expect(prompts.browserAgentPrompt(input)).toBe(buildBrowserAgentPrompt(input));

    const skill = renderLemmaSkillTemplate({ cli: "lemma", personasDir: "./personas" });
    expect(skill).toContain("name: lemma");
    expect(skill).toContain("59 assay-style commands");
    expect(skill).toContain(CONTEXT_PROTOCOL);
    expect(skill).toContain("Deterministic harness owns execution, evidence, and scoring");
    expect(skill).toContain("Blocked/skipped/errored/refused checks are coverage gaps");
    expect(skill).toContain("Never ask for, echo, or persist raw secrets/tokens/credentials");
    expect(skill).toContain("no repeated commands");
  });
});
