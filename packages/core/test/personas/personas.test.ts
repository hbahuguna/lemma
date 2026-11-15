import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PersonaError,
  parseFrontmatter,
  parseFrontmatterScalar,
  parsePersonaDocument,
  readPersonaDocument,
  splitFrontmatter,
  splitSections,
} from "../../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-specialist.md", import.meta.url));

function personaError(run: () => unknown): PersonaError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PersonaError);
    return error as PersonaError;
  }
  throw new Error("expected PersonaError to be thrown");
}

describe("LEM-041 persona frontmatter parser", () => {
  it("parses scalar encodings with assay-compatible semantics", () => {
    expect(parseFrontmatterScalar(" plain ")).toBe("plain");
    expect(parseFrontmatterScalar('"quoted"')).toBe("quoted");
    expect(parseFrontmatterScalar("'single'")).toBe("single");
    expect(parseFrontmatterScalar("true")).toBe(true);
    expect(parseFrontmatterScalar("FALSE")).toBe(false);
    expect(parseFrontmatterScalar("42")).toBe(42);
    expect(parseFrontmatterScalar("-7")).toBe(-7);
    expect(parseFrontmatterScalar("[a, 42, false]")).toEqual(["a", 42, false]);
    expect(parseFrontmatterScalar("[]")).toEqual([]);
    expect(parseFrontmatterScalar("")).toBe("");
  });

  it("parses a full assay-style persona frontmatter block in insertion order", async () => {
    const text = await readFile(FIXTURE, "utf8");
    const metadata = parseFrontmatter(text);
    expect(metadata.id).toBe("fixture-specialist");
    expect(metadata.name).toBe("Fixture Specialist");
    expect(metadata.version).toBe("1.0");
    expect(metadata.active).toBe(true);
    expect(metadata.rank).toBe(7);
    expect(metadata.quoted).toBe("quoted value");
    expect(metadata.inline).toEqual(["functional", 42, false]);
    expect(metadata.domains).toEqual(["functional", "data_integrity"]);
    expect(metadata.tools).toEqual(["source_inventory", "test_inventory"]);
    expect(metadata.checks).toEqual(["static.inventory", "static.dependencies"]);
    expect(Object.keys(metadata)).toEqual([
      "id",
      "name",
      "version",
      "active",
      "rank",
      "quoted",
      "inline",
      "domains",
      "tools",
      "checks",
    ]);
  });

  it("appends block list items and resets a key when it becomes a list", () => {
    const metadata = parseFrontmatter(
      [
        "---",
        "list:",
        "  - one",
        "  - two",
        "empty:",
        "reset: text",
        "reset:",
        "  - three",
        "indented:",
        "    - deep",
        "---",
        "body",
      ].join("\n"),
    );
    expect(metadata.list).toEqual(["one", "two"]);
    expect(metadata.empty).toEqual([]);
    expect(metadata.reset).toEqual(["three"]);
    expect(metadata.indented).toEqual(["deep"]);
  });

  it("throws typed PersonaError for malformed frontmatter", () => {
    const missingOpening = personaError(() => parseFrontmatter("id: x\n---\n"));
    expect(missingOpening.errorCode).toBe("persona_error");
    expect(missingOpening.message).toBe(
      "Persona must start with a YAML frontmatter block delimited by ---",
    );

    const missingClosing = personaError(() => parseFrontmatter("---\nid: x\n"));
    expect(missingClosing.errorCode).toBe("persona_error");
    expect(missingClosing.message).toBe("Persona frontmatter is missing a closing ---");

    const orphanItem = personaError(() => parseFrontmatter("---\n- orphan\n---\n"));
    expect(orphanItem.message).toBe("Frontmatter list item without a key: - orphan");

    const invalidLine = personaError(() => parseFrontmatter("---\ninvalid\n---\n"));
    expect(invalidLine.message).toBe("Invalid frontmatter line: invalid");
  });

  it("splits the body and lowercases section headings, letting later duplicates win", () => {
    const split = splitFrontmatter("---\nid: x\n---\n\nBody text.");
    expect(split.frontmatter).toBe("id: x");
    expect(split.body).toContain("Body text.");
    expect(split.metadata.id).toBe("x");

    const sections = splitSections(
      "## Role\n\nfirst\n\n## Role\n\nsecond\n\n## Other Heading\n\n  trimmed  \n",
    );
    expect(sections.role).toBe("second");
    expect(sections["other heading"]).toBe("trimmed");
  });

  it("parses a full persona document into metadata, body, and sections", async () => {
    const document = await readPersonaDocument(FIXTURE);
    expect(document.metadata.id).toBe("fixture-specialist");
    expect(document.frontmatter.startsWith("id: fixture-specialist")).toBe(true);
    expect(document.body).toContain("# Fixture Specialist");
    expect(Object.keys(document.sections)).toEqual([
      "role",
      "available tools",
      "output schema",
      "blocker schema",
      "refusal handling",
    ]);
    expect(document.sections.role).toBe("Judge the release outcome.");
    expect(document.sections["available tools"]).toContain("source_inventory");
    expect(document.sections["refusal handling"]).toBe(
      "Refuse when evidence is outside the declared tools.",
    );

    const again = parsePersonaDocument(await readFile(FIXTURE, "utf8"));
    expect(again).toEqual(document);
  });

  it("throws PersonaError when a persona file cannot be read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lemma-personas-"));
    try {
      await expect(readPersonaDocument(path.join(root, "missing.md"))).rejects.toBeInstanceOf(
        PersonaError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
