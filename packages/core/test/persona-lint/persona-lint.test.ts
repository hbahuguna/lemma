import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { catalogIds, lintPersonas } from "../../src/index.js";

const PERSONAS_DIR = fileURLToPath(new URL("../../../personas", import.meta.url));

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-persona-lint-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function copyShippedPersonas(targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const name of ["functional.md", "security.md", "accessibility.md", "README.md"]) {
    const content = await readFile(path.join(PERSONAS_DIR, name), "utf8");
    await writeFile(path.join(targetDir, name), content, "utf8");
  }
}

function scaffoldLikePersona(id: string, checks: string[]): string {
  const name = id[0]!.toUpperCase() + id.slice(1);
  const checksYaml = checks.map((check) => `  - ${check}`).join("\n");
  return `---
id: ${id}
name: ${name} Specialist
version: "1.0"
domains:
  - ${id}
tools:
  - file_read
checks:
${checksYaml}
---

## Role

${name} specialist role.

## Available tools

- file_read

## Output schema

\`\`\`json
{
  "type": "object",
  "title": "${name}Finding",
  "required": [
    "title",
    "severity",
    "domain",
    "strength",
    "consequence",
    "location",
    "reproduction",
    "remediation",
    "verification"
  ],
  "properties": {
    "title": { "type": "string" },
    "severity": { "type": "string", "enum": ["critical", "high", "medium", "low", "info"] },
    "domain": { "type": "string" },
    "strength": { "type": "string", "enum": ["observed", "source_proven", "suspected"] },
    "consequence": { "type": "string" },
    "location": { "type": "string" },
    "reproduction": { "type": "string" },
    "evidence": { "type": "array", "items": { "type": "string" } },
    "remediation": { "type": "string" },
    "verification": { "type": "string" },
    "tags": { "type": "array", "items": { "type": "string" } }
  }
}
\`\`\`

## Blocker schema

\`\`\`json
{
  "type": "object",
  "title": "${name}Blocker",
  "required": [
    "persona",
    "check_id",
    "attempted_action",
    "boundary",
    "unblock_evidence",
    "covered_elsewhere"
  ],
  "properties": {
    "persona": { "type": "string" },
    "check_id": { "type": "string" },
    "attempted_action": { "type": "string" },
    "boundary": { "type": "string" },
    "unblock_evidence": { "type": "array", "items": { "type": "string" } },
    "covered_elsewhere": { "type": "boolean" },
    "covered_by": { "type": "array", "items": { "type": "string" } }
  }
}
\`\`\`

## Refusal handling

Refuse clearly.
`;
}

describe("LEM-047 personas lint", () => {
  it("lints clean shipped contracts as valid with known built-in checks", async () => {
    const report = await lintPersonas(PERSONAS_DIR, catalogIds());

    expect(report.schema_version).toBe("quality-harness.personas.lint/v1");
    expect(report.directory).toBe(PERSONAS_DIR);
    expect(report.status).toBe("valid");
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.known_check_count).toBe(catalogIds().length);
    expect(report.summary.valid_personas).toBe(4);
    expect(report.summary.files).toBe(4);
    expect(new Set(report.personas.map((persona) => persona.id))).toEqual(
      new Set(["accessibility", "functional", "manager", "security"]),
    );
  });

  it("reports directory and empty-directory failures", async () => {
    await withTempDir(async (dir) => {
      const missing = path.join(dir, "missing-personas");
      const missingReport = await lintPersonas(missing);
      expect(missingReport.status).toBe("invalid");
      expect(missingReport.errors).toEqual([
        { code: "directory_missing", message: `Personas directory not found: ${missing}` },
      ]);
      expect(missingReport.summary).toEqual({ files: 0, valid_personas: 0, errors: 1, warnings: 0 });

      const emptyDir = path.join(dir, "empty");
      await mkdir(emptyDir, { recursive: true });
      await writeFile(path.join(emptyDir, "README.md"), "# readme\n", "utf8");
      const emptyReport = await lintPersonas(emptyDir);
      expect(emptyReport.status).toBe("invalid");
      expect(emptyReport.errors).toEqual([
        { code: "no_persona_files", message: `No persona files found in ${emptyDir}` },
      ]);
      expect(emptyReport.summary.files).toBe(0);
    });
  });

  it("reports load, duplicate-id, ownership, unknown-check, schema, and placeholder issues", async () => {
    await withTempDir(async (dir) => {
      const personasDir = path.join(dir, "personas");
      await mkdir(personasDir, { recursive: true });

      await writeFile(
        path.join(personasDir, "a_one.md"),
        scaffoldLikePersona("one", ["static.inventory"]),
        "utf8",
      );
      await writeFile(
        path.join(personasDir, "b_two.md"),
        scaffoldLikePersona("two", ["static.inventory"]),
        "utf8",
      );
      await writeFile(
        path.join(personasDir, "c_dup.md"),
        scaffoldLikePersona("one", ["plugin.dup.placeholder"]).replace(/^id: one$/m, "id: one"),
        "utf8",
      );
      await writeFile(
        path.join(personasDir, "d_unknown.md"),
        scaffoldLikePersona("unknown", ["static.does_not_exist"]),
        "utf8",
      );

      const schemaPersona = scaffoldLikePersona("schema", ["static.tests"]);
      await writeFile(
        path.join(personasDir, "e_schema.md"),
        schemaPersona.replace('    "severity",\n', ""),
        "utf8",
      );

      const broken = scaffoldLikePersona("broken", ["plugin.broken.placeholder"]).replace(
        /## Blocker schema[\s\S]*?(?=## Refusal handling)/,
        "",
      );
      await writeFile(path.join(personasDir, "f_broken.md"), broken, "utf8");

      await writeFile(
        path.join(personasDir, "g_bad-frontmatter.md"),
        "not-frontmatter\n\n## Role\nx\n",
        "utf8",
      );

      const report = await lintPersonas(personasDir, catalogIds());
      const codes = new Set(report.errors.map((error) => error.code));

      expect(report.status).toBe("invalid");
      expect(codes.has("missing_section")).toBe(true);
      expect(codes.has("duplicate_ownership")).toBe(true);
      expect(codes.has("unknown_check")).toBe(true);
      expect(codes.has("schema_required_field_missing")).toBe(true);
      expect(codes.has("duplicate_persona_id")).toBe(true);
      expect(codes.has("frontmatter")).toBe(true);

      const duplicate = report.errors.find((error) => error.code === "duplicate_ownership");
      expect(duplicate?.check_id).toBe("static.inventory");
      expect(duplicate?.owners).toEqual(["one", "two"]);

      const schemaError = report.errors.find(
        (error) => error.code === "schema_required_field_missing",
      );
      expect(schemaError?.schema).toBe("output");
      expect(schemaError?.field).toBe("severity");
      expect(schemaError?.persona).toBe("schema");
      expect(schemaError?.file).toBe("e_schema.md");

      const dupId = report.errors.find((error) => error.code === "duplicate_persona_id");
      expect(dupId?.persona).toBe("one");
      expect(dupId?.file).toBe("c_dup.md");
      expect(dupId?.message).toContain("a_one.md");

      const missingSection = report.errors.find((error) => error.code === "missing_section");
      expect(missingSection?.file).toBe("f_broken.md");

      const frontmatter = report.errors.find((error) => error.code === "frontmatter");
      expect(frontmatter?.file).toBe("g_bad-frontmatter.md");

      expect(report.summary.errors).toBe(report.errors.length);
      expect(report.summary.valid_personas).toBe(report.personas.length);
      expect(report.summary.files).toBe(7);
    });
  });

  it("warns for scaffold placeholder checks unknown to the registry", async () => {
    await withTempDir(async (dir) => {
      const personasDir = path.join(dir, "personas");
      await copyShippedPersonas(personasDir);
      await writeFile(
        path.join(personasDir, "reliability.md"),
        scaffoldLikePersona("reliability", ["plugin.reliability.placeholder"]),
        "utf8",
      );

      const report = await lintPersonas(personasDir, catalogIds());
      expect(report.status).toBe("valid");
      expect(report.errors).toEqual([]);
      expect(report.warnings).toHaveLength(1);
      expect(report.warnings[0]).toMatchObject({
        code: "plugin_check_placeholder",
        file: "reliability.md",
        persona: "reliability",
        check_id: "plugin.reliability.placeholder",
      });
      expect(report.warnings[0]?.message).toContain("plugin.reliability.placeholder");
      expect(report.summary.warnings).toBe(1);
      expect(report.summary.valid_personas).toBe(4);
    });
  });
});
