import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_STATE_DIRECTORIES,
  PROJECT_STATE_FILES,
  ProjectState,
  StateError,
  readJsonFile,
} from "../../src/index.js";

const dirs: string[] = [];
async function mk(prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe("LEM-195 durable project-state structure", () => {
  it("creates documented layout and reads it via ProjectState helper", async () => {
    const root = await mk("lemma-ps-");
    const ps = new ProjectState({ root });
    const ensured = await ps.ensureLayout();
    expect(ensured.created.length).toBeGreaterThan(0);

    for (const name of PROJECT_STATE_DIRECTORIES) {
      const st = await (await import("node:fs/promises")).stat(path.join(root, ".lemma", name));
      expect(st.isDirectory()).toBe(true);
    }
    for (const name of PROJECT_STATE_FILES) {
      const st = await (await import("node:fs/promises")).stat(path.join(root, ".lemma", name));
      expect(st.isFile()).toBe(true);
    }

    const listed = await ps.list();
    expect(listed.directories.every((d) => d.exists)).toBe(true);
    expect(listed.files.every((f) => f.exists)).toBe(true);

    const validation = await ps.validateLayout();
    expect(validation.ok).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  it("performs atomic JSON writes/reads per subdirectory using shared primitives", async () => {
    const root = await mk("lemma-ps-atomic-");
    const ps = new ProjectState({ root });
    await ps.ensureLayout();

    await ps.writeJson(path.join("framework", "config.json"), { schema_version: "x", a: 1 });
    await ps.writeJson(path.join("learning", "state.json"), { items: [1, 2, 3] });
    await ps.writeJson(path.join("recordings", "meta.json"), { ok: true });
    await ps.writeJson(path.join("tests", "suite.json"), { name: "s" });
    await ps.writeJson(path.join("auto", "cursor.json"), { cycle: 1 });

    expect(await ps.readJson(path.join("framework", "config.json"))).toEqual({ schema_version: "x", a: 1 });
    expect(await ps.readJson(path.join("learning", "state.json"))).toEqual({ items: [1, 2, 3] });
    expect(await ps.readJson(path.join("recordings", "meta.json"))).toEqual({ ok: true });
    expect(await ps.readJson(path.join("tests", "suite.json"))).toEqual({ name: "s" });
    expect(await ps.readJson(path.join("auto", "cursor.json"))).toEqual({ cycle: 1 });

    // written atomically as valid JSON files on disk
    const raw = await readFile(path.join(root, ".lemma", "framework", "config.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    // readJsonFile primitive works consistently
    expect(await readJsonFile(path.join(root, ".lemma", "tests", "suite.json"))).toEqual({ name: "s" });
  });

  it("doctor/validation reports missing or corrupt layout with typed errors and preserves corrupt state", async () => {
    const root = await mk("lemma-ps-doctor-");
    const ps = new ProjectState({ root });
    await ps.ensureLayout();

    // corrupt a JSON file and remove a directory
    const corruptPath = path.join(root, ".lemma", "history.json");
    await writeFile(corruptPath, "{not-json", "utf8");
    await rm(path.join(root, ".lemma", "framework"), { recursive: true, force: true });

    const validation = await ps.validateLayout();
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.kind === "missing_directory" && i.path.endsWith(path.join(".lemma", "framework")))).toBe(true);
    expect(validation.issues.some((i) => (i.kind === "corrupt_file" || i.kind === "corrupt_directory") && i.path.endsWith("history.json"))).toBe(true);

    await expect(ps.assertHealthy()).rejects.toBeInstanceOf(StateError);

    // corrupted state preserved for inspection, never silently deleted
    const preserved = await readFile(corruptPath, "utf8");
    expect(preserved).toBe("{not-json");
  });

  it("prune preserves corrupt entries and never deletes them", async () => {
    const root = await mk("lemma-ps-prune-");
    const ps = new ProjectState({ root });
    await ps.ensureLayout();

    // create continuous history entries (valid + corrupt)
    const hdir = path.join(root, ".lemma", "continuous", "pr", "history");
    await (await import("node:fs/promises")).mkdir(hdir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      await writeFile(path.join(hdir, `2026-01-01T00-00-0${i}Z-a.json`), JSON.stringify({ schema_version: "lemma.continuous_history/v1", id: `a${i}`, trigger: "pr", timestamp: `2026-01-01T00:00:0${i}Z`, status: "completed", scope: {}, result: {} }, null, 2), "utf8");
    }
    const corrupt = path.join(hdir, "2026-01-01T00-00-09Z-corrupt.json");
    await writeFile(corrupt, "{bad", "utf8");

    const res = await ps.prune({ retention: 1, directories: ["continuous"] });
    expect(res.preserved_corrupt.some((p) => p.endsWith("corrupt.json"))).toBe(true);
    expect(await readFile(corrupt, "utf8")).toBe("{bad"); // preserved
  });
});
