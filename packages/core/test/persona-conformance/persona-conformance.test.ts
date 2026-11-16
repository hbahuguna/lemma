import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PersonaError,
  TOOL_CAPABILITY_PATTERN,
  catalogIds,
  checkOwnership,
  loadPersona,
  loadPersonas,
  validateOwnership,
  validatePayload,
  validatePersonaChecks,
  validatePersonaToolCapabilities,
} from "../../src/index.js";

const PERSONAS_DIR = fileURLToPath(new URL("../../../personas", import.meta.url));

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

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-persona-conformance-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-049 persona conformance", () => {
  it("loads the shipped persona contracts with valid tool capabilities and schemas (including manager)", async () => {
    const personas = await loadPersonas(PERSONAS_DIR, { requireMinimum: 3 });
    expect(new Set(personas.map((persona) => persona.id))).toEqual(
      new Set(["accessibility", "functional", "manager", "security"]),
    );
    for (const persona of personas) {
      expect(persona.domains.length).toBeGreaterThan(0);
      expect(persona.tools.length).toBeGreaterThan(0);
      if (persona.id !== "manager") {
        expect(persona.checks.length).toBeGreaterThan(0);
      } else {
        expect(persona.checks).toEqual([]);
      }
      for (const tool of persona.tools) {
        expect(tool).toMatch(TOOL_CAPABILITY_PATTERN);
      }
      expect(persona.output_schema.type).toBe("object");
      expect(Array.isArray(persona.output_schema.required)).toBe(true);
      expect((persona.output_schema.required ?? []).length).toBeGreaterThan(0);
      expect(persona.output_schema.properties && typeof persona.output_schema.properties === "object").toBe(
        true,
      );
      expect(persona.blocker_schema.type).toBe("object");
      expect(Array.isArray(persona.blocker_schema.required)).toBe(true);
      expect(persona.blocker_schema.properties && typeof persona.blocker_schema.properties === "object").toBe(
        true,
      );
    }
  });

  it("enforces tool capability format and uniqueness", async () => {
    expect(validatePersonaToolCapabilities(["source_inventory", "browser_console"])).toEqual([
      "source_inventory",
      "browser_console",
    ]);
    expect(() => validatePersonaToolCapabilities(["Bad-Tool"])).toThrow(PersonaError);
    expect(() => validatePersonaToolCapabilities(["source_inventory", "source_inventory"])).toThrow(
      /duplicate frontmatter tool capability/,
    );
    expect(() => validatePersonaToolCapabilities([""])).toThrow(PersonaError);
    expect(() => validatePersonaToolCapabilities([123])).toThrow(PersonaError);

    await withTempDir(async (dir) => {
      const broken = path.join(dir, "broken.md");
      await writeFile(
        broken,
        `---
id: broken
name: Broken
version: "1.0"
domains:
  - functional
tools:
  - Bad-Tool
checks:
  - static.inventory
---

## Role

Text.

## Available tools

Text.

## Output schema

\`\`\`json
{"type":"object","required":["title"],"properties":{"title":{"type":"string"}}}
\`\`\`

## Blocker schema

\`\`\`json
{"type":"object","required":["persona"],"properties":{"persona":{"type":"string"}}}
\`\`\`

## Refusal handling

Text.
`,
        "utf8",
      );
      await expect(loadPersona(broken)).rejects.toMatchObject({
        name: "PersonaError",
      });
      await expect(loadPersona(broken)).rejects.toThrow(/tool capability/);
    });
  });

  it("references only catalog checks with disjoint ownership covering the full catalog", async () => {
    const personas = await loadPersonas(PERSONAS_DIR, { requireMinimum: 3 });
    const known = catalogIds();
    expect(() => validatePersonaChecks(personas, known)).not.toThrow();

    const ownership = checkOwnership(personas);
    const owners = Object.entries(ownership);
    expect(owners.length).toBe(known.length);
    for (const [checkId, claimedBy] of owners) {
      expect(claimedBy).toHaveLength(1);
      expect(known).toContain(checkId);
    }
    expect(() => validateOwnership(personas, known)).not.toThrow();
    expect(new Set(Object.keys(ownership))).toEqual(new Set(known));
  });

  it("accepts valid payloads and rejects invalid payloads for each specialist schema", async () => {
    const personas = await loadPersonas(PERSONAS_DIR, { requireMinimum: 3 });
    for (const persona of personas) {
      const payload = validFinding(persona.domains[0] ?? "functional");
      expect(validatePayload(payload, persona.output_schema)).toEqual([]);

      const missing = { ...payload };
      delete missing.remediation;
      const missingErrors = validatePayload(missing, persona.output_schema);
      expect(missingErrors.some((error) => error.includes("remediation"))).toBe(true);

      const badSeverity = { ...payload, severity: "blocker" };
      const severityErrors = validatePayload(badSeverity, persona.output_schema);
      expect(severityErrors.some((error) => error.includes("not one of"))).toBe(true);
    }
  });

  it("rejects malformed contracts such as missing required sections", async () => {
    await withTempDir(async (dir) => {
      const broken = path.join(dir, "broken.md");
      await writeFile(
        broken,
        `---
id: broken
name: Broken
domains:
  - functional
tools:
  - nothing
checks:
  - static.inventory
---

## Role

Text.

## Available tools

None.

## Output schema

\`\`\`json
{"type":"object","required":["title"],"properties":{"title":{"type":"string"}}}
\`\`\`
`,
        "utf8",
      );
      await expect(loadPersona(broken)).rejects.toBeInstanceOf(PersonaError);
    });
  });
});
