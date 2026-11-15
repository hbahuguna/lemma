import { describe, expect, it } from "vitest";

import {
  CORE_BLOCKER_FIELDS,
  CORE_FINDING_FIELDS,
  PersonaError,
  SUPPORTED_SCHEMA_TYPES,
  extractJsonSchema,
  matchesSchemaType,
  parsePersonaDocument,
  validateBlocker,
  validatePayload,
  type PersonaJsonSchema,
} from "../../src/index.js";

function personaError(run: () => unknown): PersonaError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaError);
    return error as PersonaError;
  }
  throw new Error("expected PersonaError to be thrown");
}

function schemaBlock(schema: unknown, language = "json"): string {
  return ["```" + language, JSON.stringify(schema, null, 2), "```"].join("\n");
}

function outputSchema(): PersonaJsonSchema {
  return {
    type: "object",
    title: "FixtureFinding",
    required: [...CORE_FINDING_FIELDS],
    properties: {
      title: { type: "string" },
      severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
      domain: { type: "string", enum: ["functional", "data_integrity"] },
      strength: { type: "string", enum: ["observed", "source_proven", "suspected"] },
      consequence: { type: "string" },
      location: { type: "string" },
      reproduction: { type: "string" },
      evidence: { type: "array", items: { type: "string" } },
      remediation: { type: "string" },
      verification: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
  };
}

function blockerSchema(): PersonaJsonSchema {
  return {
    type: "object",
    title: "FixtureBlocker",
    required: [...CORE_BLOCKER_FIELDS],
    properties: {
      persona: { type: "string" },
      check_id: { type: "string" },
      attempted_action: { type: "string" },
      boundary: { type: "string" },
      unblock_evidence: { type: "array", items: { type: "string" } },
      covered_elsewhere: { type: "boolean" },
      covered_by: { type: "array", items: { type: "string" } },
    },
  };
}

function validFinding(): Record<string, unknown> {
  return {
    title: "A concrete barrier",
    severity: "medium",
    domain: "functional",
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

function validBlocker(): Record<string, unknown> {
  return {
    persona: "functional",
    check_id: "browser.accessibility",
    attempted_action: "Inspect the rendered accessibility tree.",
    boundary: "The browser is unavailable.",
    unblock_evidence: ["Install Chromium and rerun the check."],
    covered_elsewhere: false,
    covered_by: [],
  };
}

function personaDocument(): string {
  return [
    "---",
    "id: fixture",
    "name: Fixture Specialist",
    "domains: [functional]",
    "tools: [source_inventory]",
    "checks: [static.inventory]",
    "---",
    "",
    "## Role",
    "",
    "Role text.",
    "",
    "## Available tools",
    "",
    "Tools text.",
    "",
    "## Output schema",
    "",
    schemaBlock(outputSchema()),
    "",
    "## Blocker schema",
    "",
    schemaBlock(blockerSchema()),
    "",
    "## Refusal handling",
    "",
    "Refuse when evidence is outside the declared tools.",
  ].join("\n");
}

describe("LEM-042 persona output and blocker schema validation", () => {
  it("exports the assay core field and supported type constants", () => {
    expect(CORE_FINDING_FIELDS).toEqual([
      "title",
      "severity",
      "domain",
      "strength",
      "consequence",
      "location",
      "reproduction",
      "remediation",
      "verification",
    ]);
    expect(CORE_BLOCKER_FIELDS).toEqual([
      "persona",
      "check_id",
      "attempted_action",
      "boundary",
      "unblock_evidence",
      "covered_elsewhere",
    ]);
    expect(SUPPORTED_SCHEMA_TYPES).toEqual([
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ]);
  });

  it("extracts a case-insensitive fenced JSON schema and ignores surrounding prose", () => {
    const schema = extractJsonSchema(
      "Prose before.\n\n```JSON\n" + JSON.stringify(outputSchema()) + "\n```\n\nProse after.",
      "output schema",
      "functional.md",
    );
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("title");
    expect(Object.keys(schema.properties ?? {})).toContain("severity");
  });

  it("rejects malformed schema sections with typed PersonaError messages", () => {
    const missingBlock = personaError(() => extractJsonSchema("no block here", "output schema", "p.md"));
    expect(missingBlock.errorCode).toBe("persona_error");
    expect(missingBlock.message).toBe(
      "p.md: output schema section needs a ```json fenced block",
    );

    const invalidJson = personaError(() =>
      extractJsonSchema("```json\n{not json}\n```", "output schema", "p.md"),
    );
    expect(invalidJson.message).toContain("p.md: output schema JSON is invalid:");

    const notObject = personaError(() =>
      extractJsonSchema("```json\n[1, 2]\n```", "output schema", "p.md"),
    );
    expect(notObject.message).toBe("p.md: output schema must be a JSON object");

    const wrongType = personaError(() =>
      extractJsonSchema(
        schemaBlock({ type: "array", required: ["a"], properties: { a: { type: "string" } } }),
        "output schema",
        "p.md",
      ),
    );
    expect(wrongType.message).toBe("p.md: output schema type must be 'object'");

    const emptyRequired = personaError(() =>
      extractJsonSchema(
        schemaBlock({ type: "object", required: [], properties: { a: { type: "string" } } }),
        "blocker schema",
        "p.md",
      ),
    );
    expect(emptyRequired.message).toBe(
      "p.md: blocker schema needs a non-empty required array",
    );

    const emptyProperties = personaError(() =>
      extractJsonSchema(
        schemaBlock({ type: "object", required: ["a"], properties: {} }),
        "blocker schema",
        "p.md",
      ),
    );
    expect(emptyProperties.message).toBe("p.md: blocker schema needs a properties object");
  });

  it("matches declared JSON-Schema types, treating unknown types as permissive", () => {
    expect(matchesSchemaType({}, "object")).toBe(true);
    expect(matchesSchemaType([], "object")).toBe(false);
    expect(matchesSchemaType([], "array")).toBe(true);
    expect(matchesSchemaType("x", "string")).toBe(true);
    expect(matchesSchemaType(2, "number")).toBe(true);
    expect(matchesSchemaType(2, "integer")).toBe(true);
    expect(matchesSchemaType(2.5, "integer")).toBe(false);
    expect(matchesSchemaType(false, "boolean")).toBe(true);
    expect(matchesSchemaType(null, "null")).toBe(true);
    expect(matchesSchemaType("anything", "mystery")).toBe(true);
  });

  it("validates payload types, enums, required fields, nested properties, and array items", () => {
    const schema = outputSchema();
    expect(validatePayload(validFinding(), schema)).toEqual([]);

    // Type failures short-circuit before required/enum checks.
    expect(validatePayload(42, schema)).toEqual(["$: expected type object, got integer"]);
    expect(validatePayload({ title: ["not", "a", "string"] }, schema)).toContain(
      "$.title: expected type string, got array",
    );

    const badEnum = validatePayload({ ...validFinding(), severity: "blocker" }, schema);
    expect(badEnum).toHaveLength(1);
    expect(badEnum[0]).toContain("$.severity: value \"blocker\" is not one of");

    const badDomain = validatePayload({ ...validFinding(), domain: "security" }, schema);
    expect(badDomain).toHaveLength(1);
    expect(badDomain[0]).toContain("$.domain: value \"security\" is not one of");

    const missing = { ...validFinding() };
    delete missing.remediation;
    expect(validatePayload(missing, schema)).toContain(
      "$: missing required property 'remediation'",
    );

    const wrongNestedType = validatePayload({ ...validFinding(), title: 7 }, schema);
    expect(wrongNestedType).toContain("$.title: expected type string, got integer");

    const badArrayItem = validatePayload(
      { ...validFinding(), evidence: ["ok", 5] },
      schema,
    );
    expect(badArrayItem).toContain("$.evidence[1]: expected type string, got integer");
  });

  it("compares enum members by deep equality", () => {
    const schema: PersonaJsonSchema = { enum: [[1, 2], { a: 1 }] };
    expect(validatePayload([1, 2], schema)).toEqual([]);
    expect(validatePayload({ a: 1 }, schema)).toEqual([]);
    expect(validatePayload([2, 1], schema)).toHaveLength(1);
    expect(validatePayload({ a: 2 }, schema)).toHaveLength(1);
  });

  it("validates blocker payloads against a blocker schema", () => {
    const schema = blockerSchema();
    expect(validateBlocker(validBlocker(), schema)).toEqual([]);

    const missingBoundary = { ...validBlocker() };
    delete missingBoundary.boundary;
    expect(validateBlocker(missingBoundary, schema)).toContain(
      "$: missing required property 'boundary'",
    );

    expect(validateBlocker({ ...validBlocker(), covered_elsewhere: "no" }, schema)).toContain(
      "$.covered_elsewhere: expected type boolean, got string",
    );
  });

  it("validates a parsed persona's output and blocker contracts end to end", () => {
    const document = parsePersonaDocument(personaDocument());
    const findingSchema = extractJsonSchema(
      document.sections["output schema"] ?? "",
      "output schema",
      "fixture.md",
    );
    const refusalSchema = extractJsonSchema(
      document.sections["blocker schema"] ?? "",
      "blocker schema",
      "fixture.md",
    );

    expect(validatePayload(validFinding(), findingSchema)).toEqual([]);
    expect(validateBlocker(validBlocker(), refusalSchema)).toEqual([]);

    const badSeverity = validatePayload(
      { ...validFinding(), severity: "blocker" },
      findingSchema,
    );
    expect(badSeverity).toContainEqual(
      expect.stringContaining("$.severity: value \"blocker\" is not one of"),
    );

    const missingVerification = { ...validFinding() };
    delete missingVerification.verification;
    expect(validatePayload(missingVerification, findingSchema)).toContain(
      "$: missing required property 'verification'",
    );

    const badTitle = validatePayload({ ...validFinding(), title: 42 }, findingSchema);
    expect(badTitle).toContain("$.title: expected type string, got integer");

    const missingBoundary = { ...validBlocker() };
    delete missingBoundary.boundary;
    expect(validateBlocker(missingBoundary, refusalSchema)).toContain(
      "$: missing required property 'boundary'",
    );
  });
});
