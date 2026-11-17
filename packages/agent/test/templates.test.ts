import { describe, expect, it } from "vitest";

import { ASSAY_COMMAND_CATALOG } from "../src/index.js";
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
    expect(browser?.markdown).toContain("Require a reachable `http(s)` URL");
    expect(browser?.markdown).toContain("Do not substitute");
    expect(browser?.markdown).toContain("lemma browser <URL>");
    expect(browser?.markdown).not.toContain("Context gathering");
    expect(browser?.markdown).not.toContain("context protocol");
    expect(browser?.markdown).not.toContain("/Users/");

    const demo = renderCatalogCommandTemplate("assay-demo", { cli: "lemma", personasDir: "./personas" });
    expect(demo?.kind).toBe("demo");
    expect(demo?.markdown).toContain("If no URL is provided");
    expect(demo?.markdown).toContain("static");
    expect(demo?.markdown).toContain("live browser");
    expect(demo?.markdown).toContain("--no-browser");

    const security = renderCatalogCommandTemplate("assay-security", { cli: "lemma", personasDir: "./personas" });
    expect(security?.kind).toBe("static");
    expect(security?.markdown).toContain("Run a Lemma **security** assessment");
    expect(security?.markdown).toContain("lemma browser <URL>");
    expect(security?.markdown).not.toContain("Context gathering");
    expect(security?.markdown).not.toContain("context protocol");
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

  it("reuses prompt primitives and renders skill template without context gathering", () => {
    const prompts = renderPromptTemplates();
    expect(prompts.contextProtocol).toBe("");
    expect("browserAgentPrompt" in prompts).toBe(false);

    const skill = renderLemmaSkillTemplate({ cli: "lemma", personasDir: "./personas" });
    expect(skill).toContain("name: lemma");
    expect(skill).toContain("60 Lemma commands");
    expect(skill).not.toContain("Context protocol");
    expect(skill).not.toContain("Context gathering");
    expect(skill).toContain("Deterministic harness owns execution, evidence, and scoring");
    expect(skill).toContain("Blocked/skipped/errored/refused checks are coverage gaps");
    expect(skill).toContain("Never ask for, echo, or persist raw secrets/tokens/credentials");
    expect(skill).toContain("no repeated commands");
  });
});
