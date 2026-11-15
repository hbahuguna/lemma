import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PersonaError,
  catalogIds,
  lintPersonas,
  loadPersona,
  scaffoldPersona,
} from "../../src/index.js";

const PERSONAS_DIR = fileURLToPath(new URL("../../../personas", import.meta.url));

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-persona-scaffold-"));
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

describe("LEM-048 personas scaffold", () => {
  it("writes a starter contract that loads and lints unchanged with a placeholder warning", async () => {
    await withTempDir(async (dir) => {
      const personasDir = path.join(dir, "personas");
      await copyShippedPersonas(personasDir);

      const result = await scaffoldPersona("reliability", personasDir);
      expect(result.schema_version).toBe("quality-harness.personas.scaffold/v1");
      expect(result.status).toBe("created");
      expect(result.persona_id).toBe("reliability");
      expect(result.path).toBe(path.join(personasDir, "reliability.md"));
      expect(result.domains).toEqual(["reliability"]);
      expect(result.checks).toEqual(["plugin.reliability.placeholder"]);
      expect(result.force).toBe(false);
      expect(result.next_steps.length).toBeGreaterThan(0);

      const persona = await loadPersona(result.path);
      expect(persona.id).toBe("reliability");
      expect(persona.name).toBe("Reliability");
      expect(persona.domains).toEqual(["reliability"]);
      expect(persona.tools).toEqual(["source_inventory"]);
      expect(persona.checks).toEqual(["plugin.reliability.placeholder"]);
      expect(persona.output_schema.title).toBe("ReliabilityFinding");
      expect(persona.blocker_schema.title).toBe("ReliabilityBlocker");
      expect(persona.output_schema.required).toEqual(expect.arrayContaining(["title", "severity", "verification"]));

      const lint = await lintPersonas(personasDir, catalogIds());
      expect(lint.status).toBe("valid");
      expect(lint.errors).toEqual([]);
      expect(lint.summary.valid_personas).toBe(4);
      expect(lint.warnings).toHaveLength(1);
      expect(lint.warnings[0]).toMatchObject({
        code: "plugin_check_placeholder",
        persona: "reliability",
        check_id: "plugin.reliability.placeholder",
        file: "reliability.md",
      });
    });
  });

  it("refuses to overwrite without force and overwrites with force", async () => {
    await withTempDir(async (dir) => {
      const personasDir = path.join(dir, "personas");
      await mkdir(personasDir, { recursive: true });

      const created = await scaffoldPersona("reliability", personasDir);
      expect(created.status).toBe("created");
      const original = await readFile(created.path, "utf8");

      const refused = await scaffoldPersona("reliability", personasDir);
      expect(refused.status).toBe("refused");
      expect(refused.force).toBe(false);
      expect(refused.reason).toContain("--force");
      expect(refused.next_steps).toEqual([
        "Re-run with --force to overwrite the existing contract.",
      ]);
      expect(await readFile(created.path, "utf8")).toBe(original);

      const overwritten = await scaffoldPersona("reliability", personasDir, { force: true });
      expect(overwritten.status).toBe("overwritten");
      expect(overwritten.force).toBe(true);
      expect(await readFile(created.path, "utf8")).toBe(original);
    });
  });

  it("accepts custom name, domains, and checks", async () => {
    await withTempDir(async (dir) => {
      const personasDir = path.join(dir, "personas");
      await mkdir(personasDir, { recursive: true });

      const result = await scaffoldPersona("performance", personasDir, {
        name: "Performance Specialist",
        domains: ["performance", "reliability"],
        checks: ["plugin.performance.load"],
      });

      expect(result.status).toBe("created");
      expect(result.domains).toEqual(["performance", "reliability"]);
      expect(result.checks).toEqual(["plugin.performance.load"]);

      const persona = await loadPersona(result.path);
      expect(persona.name).toBe("Performance Specialist");
      expect(persona.domains).toEqual(["performance", "reliability"]);
      expect(persona.checks).toEqual(["plugin.performance.load"]);
      expect(persona.output_schema.title).toBe("PerformanceSpecialistFinding");
      expect((persona.output_schema.properties?.domain as { enum?: unknown[] } | undefined)?.enum).toEqual([
        "performance",
        "reliability",
      ]);
    });
  });

  it("validates inputs and rejects invalid scaffold requests", async () => {
    await withTempDir(async (dir) => {
      const personasDir = path.join(dir, "personas");
      await mkdir(personasDir, { recursive: true });

      await expect(scaffoldPersona("Bad-Id", personasDir)).rejects.toThrow(PersonaError);
      await expect(scaffoldPersona("ok", personasDir, { name: "line\nbreak" })).rejects.toThrow(
        "Persona name must be non-empty single-line text.",
      );
      await expect(scaffoldPersona("ok", personasDir, { domains: ["BadDomain"] })).rejects.toThrow(
        "Persona domains must be lowercase words",
      );
      await expect(scaffoldPersona("ok", personasDir, { checks: ["Bad Check"] })).rejects.toThrow(
        "Persona checks must be non-empty ids",
      );
      await expect(
        scaffoldPersona("ok", personasDir, { checks: ["plugin.ok.one", "plugin.ok.one"] }),
      ).rejects.toThrow("Persona checks must not contain duplicate ids.");

      const dirPath = path.join(personasDir, "taken.md");
      await mkdir(dirPath, { recursive: true });
      await expect(scaffoldPersona("taken", personasDir, { force: true })).rejects.toThrow(
        `Persona path is a directory: ${dirPath}`,
      );
    });
  });
});
