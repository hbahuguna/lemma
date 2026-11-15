import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CHECK_CATALOG,
  HarnessError,
  PersonaError,
  catalogIds,
  checkOwnership,
  loadPersonas,
  normalizeTarget,
  ownershipErrorMessage,
  planChecks,
  unknownPersonaCheckIds,
  validateOwnership,
  validatePersonaChecks,
  type PersonaOwnershipSource,
} from "../../src/index.js";

const PERSONAS_DIR = fileURLToPath(new URL("../../../personas", import.meta.url));

function planInput(
  personas: PersonaOwnershipSource[],
  ownership: Record<string, string[]>,
  selected?: string[],
): Parameters<typeof planChecks>[0] {
  return {
    target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
    inventory: { available: true, has_markup: true, has_manifest: true },
    selectedPersonas: selected ?? personas.map((persona) => persona.id),
    ownership,
    maxChecks: 0,
    noBrowser: true,
  };
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

function harnessError(run: () => unknown): HarnessError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError);
    return error as HarnessError;
  }
  throw new Error("expected HarnessError to be thrown");
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-ownership-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function copyPersonas(destination: string): Promise<string> {
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(PERSONAS_DIR)) {
    if (!name.toLowerCase().endsWith(".md") || name.toLowerCase().startsWith("readme")) {
      continue;
    }
    const text = await readFile(path.join(PERSONAS_DIR, name), "utf8");
    await writeFile(path.join(destination, name), text, "utf8");
  }
  return destination;
}

async function removeCheckFromAll(personasDir: string, checkId: string): Promise<void> {
  const needle = `  - ${checkId}\n`;
  for (const name of await readdir(personasDir)) {
    if (!name.toLowerCase().endsWith(".md") || name.toLowerCase().startsWith("readme")) {
      continue;
    }
    const filePath = path.join(personasDir, name);
    const text = await readFile(filePath, "utf8");
    await writeFile(filePath, text.replaceAll(needle, ""), "utf8");
  }
}

async function addCheckToPersona(filePath: string, checkId: string): Promise<void> {
  const text = await readFile(filePath, "utf8");
  const marker = "checks:\n";
  if (!text.includes(marker)) {
    throw new Error("persona has no checks frontmatter");
  }
  await writeFile(filePath, text.replace(marker, `${marker}  - ${checkId}\n`), "utf8");
}

describe("LEM-044 ownership derivation and disjointness enforcement", () => {
  it("derives one owner for every catalog check from persona frontmatter", async () => {
    const personas = await loadPersonas(PERSONAS_DIR);
    expect(CHECK_CATALOG.every((definition) => definition.persona === "")).toBe(true);

    const ownership = checkOwnership(personas);
    expect(Object.keys(ownership).sort()).toEqual([...catalogIds()].sort());
    for (const owners of Object.values(ownership)) {
      expect(owners).toHaveLength(1);
      expect(owners[0]).toBeTruthy();
    }
    expect(ownership["static.full_assessment"]).toEqual(["functional"]);
    expect(ownership["static.secrets"]).toEqual(["security"]);
    expect(ownership["browser.accessibility"]).toEqual(["accessibility"]);
    expect(ownership["static.category.security"]).toEqual(["functional"]);
    expect(ownership["static.category.performance"]).toEqual(["functional"]);

    expect(validateOwnership(personas, catalogIds())).toEqual(ownership);
  });

  it("formats assay-compatible ownership configuration errors", () => {
    expect(ownershipErrorMessage("static.inventory", [])).toBe(
      "Check 'static.inventory' has no declared persona owner; it must be listed by exactly one persona contract.",
    );
    expect(ownershipErrorMessage("static.inventory", ["security", "functional"])).toBe(
      "Check 'static.inventory' is claimed by multiple personas (functional, security); it must be listed by exactly one persona contract.",
    );
  });

  it("reports unknown persona check ids in contract order", () => {
    const personas: PersonaOwnershipSource[] = [
      { id: "one", checks: ["static.inventory", "static.does_not_exist"] },
      { id: "two", checks: ["static.also_missing", "static.does_not_exist"] },
    ];
    expect(unknownPersonaCheckIds(personas, ["static.inventory"])).toEqual([
      ["one", "static.does_not_exist"],
      ["two", "static.also_missing"],
      ["two", "static.does_not_exist"],
    ]);

    const error = personaError(() => validatePersonaChecks(personas, ["static.inventory"]));
    expect(error.errorCode).toBe("persona_error");
    expect(error.message).toBe(
      "Persona 'one' references unknown check id(s): static.also_missing, static.does_not_exist",
    );
  });

  it("rejects duplicate and missing owners over a known check set", () => {
    const duplicate: PersonaOwnershipSource[] = [
      { id: "functional", checks: ["static.inventory"] },
      { id: "security", checks: ["static.inventory"] },
    ];
    const duplicateError = personaError(() =>
      validateOwnership(duplicate, ["static.inventory"]),
    );
    expect(duplicateError.message).toBe(
      ownershipErrorMessage("static.inventory", ["functional", "security"]),
    );

    const missing = personaError(() =>
      validateOwnership([{ id: "functional", checks: [] }], ["static.inventory"]),
    );
    expect(missing.message).toBe(ownershipErrorMessage("static.inventory", []));
  });

  it("validates unknown ids before checking catalog ownership", () => {
    const error = personaError(() =>
      validateOwnership([{ id: "functional", checks: ["static.unknown"] }], [
        "static.inventory",
      ]),
    );
    expect(error.message).toBe(
      "Persona 'functional' references unknown check id(s): static.unknown",
    );
  });

  it("fails planning when a built-in check has no persona owner", async () => {
    await withTempDir(async (dir) => {
      const personasDir = await copyPersonas(path.join(dir, "personas"));
      await removeCheckFromAll(personasDir, "static.inventory");
      const personas = await loadPersonas(personasDir);
      const ownership = checkOwnership(personas);
      expect(ownership["static.inventory"]).toBeUndefined();

      const error = harnessError(() => planChecks(planInput(personas, ownership)));
      expect(error.message).toContain("static.inventory");
      expect(error.message).toContain("has no declared persona owner");
      expect(error.message).toContain("exactly one persona contract");
    });
  });

  it("fails validation and planning when a built-in check is multiply owned", async () => {
    await withTempDir(async (dir) => {
      const personasDir = await copyPersonas(path.join(dir, "personas"));
      await addCheckToPersona(path.join(personasDir, "security.md"), "static.inventory");
      const personas = await loadPersonas(personasDir);

      const error = personaError(() => validateOwnership(personas, catalogIds()));
      expect(error.message).toBe(
        ownershipErrorMessage("static.inventory", ["functional", "security"]),
      );

      const ownership = checkOwnership(personas);
      expect(ownership["static.inventory"]).toEqual(["functional", "security"]);
      const plannedError = harnessError(() => planChecks(planInput(personas, ownership)));
      expect(plannedError.message).toContain("static.inventory");
      expect(plannedError.message).toContain("functional");
      expect(plannedError.message).toContain("security");
    });
  });

  it("plans checks using frontmatter-derived ownership", async () => {
    const personas = await loadPersonas(PERSONAS_DIR);
    const ownership = validateOwnership(personas, catalogIds());
    const planned = planChecks(planInput(personas, ownership));

    expect(planned.length).toBeGreaterThan(0);
    for (const check of planned) {
      expect(check.persona).toBe(ownership[check.id]?.[0]);
    }
    expect(planned.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "static.inventory",
        "static.tests",
        "static.ci",
        "static.dependencies",
        "static.secrets",
        "static.accessibility",
      ]),
    );
  });

  it("uses the full ownership map when planning a selected persona subset", async () => {
    const personas = await loadPersonas(PERSONAS_DIR);
    const ownership = validateOwnership(personas, catalogIds());
    const planned = planChecks(planInput(personas, ownership, ["accessibility"]));

    expect(planned.map((check) => check.id)).toEqual(["static.accessibility"]);
    expect(planned.every((check) => check.persona === "accessibility")).toBe(true);
  });

  it("is deterministic, non-mutating, and accepts generators", () => {
    const source: PersonaOwnershipSource[] = [
      { id: "security", checks: ["static.inventory"] },
      { id: "functional", checks: ["static.inventory"] },
    ];
    const snapshot = JSON.stringify(source);
    const ownership = checkOwnership(source);
    expect(ownership["static.inventory"]).toEqual(["functional", "security"]);
    expect(JSON.stringify(source)).toBe(snapshot);

    function* generated(): Generator<PersonaOwnershipSource> {
      yield* source;
    }
    expect(checkOwnership(generated())).toEqual(ownership);

    const ordered = checkOwnership([
      { id: "b", checks: ["z", "a"] },
      { id: "a", checks: ["z"] },
    ]);
    expect(Object.keys(ordered)).toEqual(["z", "a"]);
  });
});
