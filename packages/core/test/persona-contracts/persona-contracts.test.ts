import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CORE_BLOCKER_FIELDS,
  CORE_FINDING_FIELDS,
  PersonaError,
  loadPersona,
  loadPersonas,
  personaPublic,
  selectPersonas,
  validateBlocker,
  validatePayload,
  type Persona,
} from "../../src/index.js";

const PERSONAS_DIR = fileURLToPath(new URL("../../../personas", import.meta.url));

interface ExpectedContract {
  domains: string[];
  tools: string[];
  checks: string[];
  schemaTitle: string;
  blockerTitle: string;
}

const EXPECTED: Record<"functional" | "security" | "accessibility", ExpectedContract> = {
  functional: {
    domains: ["functional", "reliability", "content", "data_integrity"],
    tools: [
      "source_inventory",
      "test_inventory",
      "ci_inventory",
      "dependency_inventory",
      "browser_navigate",
      "browser_console",
      "browser_network",
      "browser_dom_snapshot",
      "browser_screenshot",
    ],
    checks: [
      "static.full_assessment",
      "static.test_category",
      "static.functionality_category",
      "static.browser_category",
      "static.issues_category",
      "static.demo_category",
      "static.more_category",
      "static.inventory",
      "static.tests",
      "static.ci",
      "static.dependencies",
      "browser.load",
      "browser.console",
      "browser.network",
      "browser.content",
      "browser.links",
      "browser.steps",
    ],
    schemaTitle: "FunctionalFinding",
    blockerTitle: "FunctionalBlocker",
  },
  security: {
    domains: ["security", "data_integrity"],
    tools: [
      "secret_scanner",
      "unsafe_pattern_scanner",
      "browser_security_headers",
      "browser_cookie_reader",
      "browser_form_reader",
      "browser_console",
      "browser_screenshot",
    ],
    checks: ["static.secrets", "static.unsafe", "browser.security"],
    schemaTitle: "SecurityFinding",
    blockerTitle: "SecurityBlocker",
  },
  accessibility: {
    domains: ["accessibility"],
    tools: [
      "markup_a11y_scanner",
      "browser_dom_snapshot",
      "browser_accessibility_tree",
      "browser_keyboard_probe",
      "browser_screenshot",
    ],
    checks: [
      "static.accessibility",
      "browser.accessibility",
      "browser.overflow",
      "browser.focus_order",
    ],
    schemaTitle: "AccessibilityFinding",
    blockerTitle: "AccessibilityBlocker",
  },
};

function byId(personas: Persona[], id: string): Persona {
  const found = personas.find((persona) => persona.id === id);
  if (!found) throw new Error(`missing persona ${id}`);
  return found;
}

function validFinding(domain: string): Record<string, unknown> {
  return {
    title: "A concrete barrier",
    severity: "medium",
    domain,
    strength: "observed",
    consequence: "A customer cannot complete the task.",
    location: "https://example.test/",
    reproduction: "Open the target and follow the cited flow.",
    evidence: [".lemma/evidence/run/screenshot.png"],
    remediation: "Fix the control and add a regression check.",
    verification: "Re-run the check and confirm the flow succeeds.",
    tags: ["example"],
  };
}

function validBlocker(persona: string): Record<string, unknown> {
  return {
    persona,
    check_id: "browser.accessibility",
    attempted_action: "Inspect the rendered accessibility tree.",
    boundary: "The browser is unavailable.",
    unblock_evidence: ["Install Chromium and rerun the check."],
    covered_elsewhere: false,
    covered_by: [],
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-persona-contracts-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function personaError(run: () => unknown): PersonaError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaError);
    return error as PersonaError;
  }
  throw new Error("expected PersonaError to be thrown");
}

async function loadPersonaError(filePath: string): Promise<PersonaError> {
  try {
    await loadPersona(filePath);
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaError);
    return error as PersonaError;
  }
  throw new Error("expected loadPersona to throw PersonaError");
}

async function loadPersonasError(
  directory: string,
  options?: Parameters<typeof loadPersonas>[1],
): Promise<PersonaError> {
  try {
    await loadPersonas(directory, options);
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaError);
    return error as PersonaError;
  }
  throw new Error("expected loadPersonas to throw PersonaError");
}

describe("LEM-043 functional, security, and accessibility contracts", () => {
  it("loads the three ported specialist contracts with assay ownership", async () => {
    const personas = await loadPersonas(PERSONAS_DIR, { requireMinimum: 3 });
    expect(personas.map((persona) => persona.id)).toEqual([
      "accessibility",
      "functional",
      "security",
    ]);

    for (const [id, expected] of Object.entries(EXPECTED)) {
      const persona = byId(personas, id);
      expect(persona.name.length).toBeGreaterThan(0);
      expect(persona.version).toBe("1.0");
      expect(persona.domains).toEqual(expected.domains);
      expect(persona.tools).toEqual(expected.tools);
      expect(persona.checks).toEqual(expected.checks);
      expect(persona.metadata.id).toBe(id);
      expect(persona.role.length).toBeGreaterThan(0);
      expect(persona.tools_section).toContain("| Tool | Use | Boundary |");
      expect(persona.refusal.length).toBeGreaterThan(0);
      expect(persona.body).toContain("# ");
      expect(persona.output_schema.type).toBe("object");
      expect(persona.output_schema.title).toBe(expected.schemaTitle);
      expect(persona.output_schema.required).toEqual(
        expect.arrayContaining([...CORE_FINDING_FIELDS]),
      );
      expect(Object.keys(persona.output_schema.properties ?? {})).toContain("severity");
      expect(persona.blocker_schema.type).toBe("object");
      expect(persona.blocker_schema.title).toBe(expected.blockerTitle);
      expect(persona.blocker_schema.required).toEqual(
        expect.arrayContaining([...CORE_BLOCKER_FIELDS]),
      );
    }
  });

  it("validates contract-shaped findings and blockers for every specialist", async () => {
    const personas = await loadPersonas(PERSONAS_DIR);
    for (const persona of personas) {
      const finding = validFinding(persona.domains[0] ?? "");
      expect(validatePayload(finding, persona.output_schema)).toEqual([]);

      expect(
        validatePayload({ ...finding, severity: "blocker" }, persona.output_schema).length,
      ).toBeGreaterThan(0);
      expect(
        validatePayload({ ...finding, domain: "not_owned" }, persona.output_schema).length,
      ).toBeGreaterThan(0);

      const blocker = validBlocker(persona.id);
      expect(validateBlocker(blocker, persona.blocker_schema)).toEqual([]);
      const missingBoundary = { ...blocker };
      delete missingBoundary.boundary;
      expect(validateBlocker(missingBoundary, persona.blocker_schema)).toContain(
        "$: missing required property 'boundary'",
      );
    }
  });

  it("exposes the assay-compatible public projection without embedding schemas", async () => {
    const [security] = await loadPersonas(PERSONAS_DIR, { selected: ["security"] });
    if (!security) throw new Error("missing security persona");
    const projection = personaPublic(security);
    expect(projection).toEqual({
      id: "security",
      name: "Security and Privacy Specialist",
      version: "1.0",
      domains: ["security", "data_integrity"],
      tools: EXPECTED.security.tools,
      checks: EXPECTED.security.checks,
      path: security.path,
      schema_title: "SecurityFinding",
      blocker_schema_title: "SecurityBlocker",
    });
    expect(projection).not.toHaveProperty("output_schema");
    expect(projection).not.toHaveProperty("blocker_schema");
  });

  it("rejects missing frontmatter keys and non-list ownership fields", async () => {
    const text = await readFile(path.join(PERSONAS_DIR, "functional.md"), "utf8");
    await withTempDir(async (dir) => {
      const missingNamePath = path.join(dir, "missing-name.md");
      await writeFile(missingNamePath, text.replace(/^name:.*\n/m, ""), "utf8");
      const missingName = await loadPersonaError(missingNamePath);
      expect(missingName.errorCode).toBe("persona_error");
      expect(missingName.message).toBe(
        `${missingNamePath}: missing frontmatter key 'name'`,
      );

      const scalarDomainsPath = path.join(dir, "scalar-domains.md");
      await writeFile(
        scalarDomainsPath,
        text.replace(/^domains:\n(?: {2}- .*\n)+/m, "domains: functional\n"),
        "utf8",
      );
      const scalarDomains = await loadPersonaError(scalarDomainsPath);
      expect(scalarDomains.message).toBe(`${scalarDomainsPath}: domains must be a list`);
    });
  });

  it("rejects missing sections and empty role or refusal sections", async () => {
    const text = await readFile(path.join(PERSONAS_DIR, "functional.md"), "utf8");
    await withTempDir(async (dir) => {
      const missingSectionPath = path.join(dir, "missing-section.md");
      await writeFile(
        missingSectionPath,
        text.replace(/## Blocker schema[\s\S]*?(?=## Refusal handling)/, ""),
        "utf8",
      );
      const missingSection = await loadPersonaError(missingSectionPath);
      expect(missingSection.message).toBe(
        `${missingSectionPath}: missing required section(s): ## Blocker Schema`,
      );

      const emptyRolePath = path.join(dir, "empty-role.md");
      await writeFile(
        emptyRolePath,
        text.replace(/## Role[\s\S]*?(?=## Available tools)/, "## Role\n\n"),
        "utf8",
      );
      const emptyRole = await loadPersonaError(emptyRolePath);
      expect(emptyRole.message).toBe(`${emptyRolePath}: role section is empty`);

      const emptyRefusalPath = path.join(dir, "empty-refusal.md");
      await writeFile(
        emptyRefusalPath,
        text.replace(/## Refusal handling[\s\S]*$/, "## Refusal handling\n\n"),
        "utf8",
      );
      const emptyRefusal = await loadPersonaError(emptyRefusalPath);
      expect(emptyRefusal.message).toBe(
        `${emptyRefusalPath}: refusal handling section is empty`,
      );
    });
  });

  it("enforces directory, duplicate, minimum, and selection rules", async () => {
    await withTempDir(async (dir) => {
      const missingDirectory = await loadPersonasError(path.join(dir, "missing"));
      expect(missingDirectory.message).toBe(
        `Personas directory not found: ${path.join(dir, "missing")}`,
      );

      const empty = path.join(dir, "empty");
      await writeFile(path.join(dir, "placeholder.txt"), "", "utf8");
      await mkdir(empty);
      const emptyDirectory = await loadPersonasError(empty);
      expect(emptyDirectory.message).toBe(`No persona files found in ${empty}`);

      const duplicate = path.join(dir, "duplicate");
      const text = await readFile(path.join(PERSONAS_DIR, "functional.md"), "utf8");
      await mkdir(duplicate);
      await writeFile(path.join(duplicate, "a.md"), text, "utf8");
      await writeFile(path.join(duplicate, "b.md"), text, "utf8");
      const duplicateError = await loadPersonasError(duplicate);
      expect(duplicateError.message).toBe(`Duplicate persona id 'functional' in ${duplicate}`);

      const single = path.join(dir, "single");
      await mkdir(single);
      await writeFile(path.join(single, "functional.md"), text, "utf8");
      const tooFew = await loadPersonasError(single, { requireMinimum: 3 });
      expect(tooFew.message).toBe(
        "Expected at least 3 personas, found 1. Add specialist files to personas/.",
      );
      expect(await loadPersonas(single, { requireMinimum: 0 })).toHaveLength(1);

      const unknownSelection = await loadPersonasError(PERSONAS_DIR, {
        selected: ["does-not-exist"],
      });
      expect(unknownSelection.message).toBe(
        "Unknown persona id(s): does-not-exist. Available: accessibility, functional, security",
      );
    });
  });

  it("selects persona subsets in contract order and rejects unknown ids", async () => {
    const all = await loadPersonas(PERSONAS_DIR);
    expect(selectPersonas(all).map((persona) => persona.id)).toEqual([
      "accessibility",
      "functional",
      "security",
    ]);
    expect(selectPersonas(all, []).map((persona) => persona.id)).toEqual([
      "accessibility",
      "functional",
      "security",
    ]);
    expect(selectPersonas(all, ["security", "accessibility"]).map((persona) => persona.id)).toEqual(
      ["accessibility", "security"],
    );
    expect(
      selectPersonas(all, ["functional"]).map((persona) => persona.id),
    ).toEqual(["functional"]);

    const error = personaError(() => selectPersonas(all, ["missing"]));
    expect(error.message).toBe(
      "Unknown persona id(s): missing. Available: accessibility, functional, security",
    );
  });
});
