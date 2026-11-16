import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_SUBDIRS,
  StateError,
  initConfidenceWorkspace,
  readConfidenceJson,
  regenerateConfidenceManifest,
  writeConfidenceJson,
  writeConfidenceText,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-confidence-ws-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

describe("LEM-183 confidence-engineering workspace", () => {
  it("creates .confidence/ workspace with documented subdirs and versioned manifest via atomic writes; refuses overwrite without --force", async () => {
    await withTempDir(async (root) => {
      const res = await initConfidenceWorkspace({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      expect(res.created).toBe(true);
      expect(res.overwritten).toBe(false);
      const ws = path.join(root, ".confidence");
      expect(await exists(ws)).toBe(true);
      for (const sub of CONFIDENCE_SUBDIRS) {
        expect(await exists(path.join(ws, sub))).toBe(true);
      }
      const manifestPath = path.join(ws, "workspace.manifest.json");
      expect(await exists(manifestPath)).toBe(true);
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      expect(manifest.schema_version).toBe("lemma.confidence.workspace/v1");
      expect(manifest.workspace).toBe(".confidence");
      expect(Array.isArray(manifest.artifacts)).toBe(true);

      // refuses to overwrite without --force
      await expect(initConfidenceWorkspace({ root } as any)).rejects.toBeInstanceOf(StateError);
      await expect(initConfidenceWorkspace({ root } as any)).rejects.toThrow(/--force/);

      // force overwrite recreates workspace
      await fs.writeFile(path.join(ws, "risks", "old.json"), "{\"old\":true}\n", "utf8");
      const forced = await initConfidenceWorkspace({ root, force: true, generatedAt: "2026-11-17T00:00:00Z" } as any);
      expect(forced.overwritten).toBe(true);
      expect(await exists(path.join(ws, "risks", "old.json"))).toBe(false);
    });
  });

  it("regenerates manifest atomically with stable ids and fingerprints for artifacts", async () => {
    await withTempDir(async (root) => {
      await initConfidenceWorkspace({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      await writeConfidenceJson({ root, subdir: "claims", name: "claim-a.json", value: { id: "claim-a", text: "safe" }, generatedAt: "2026-11-17T00:00:00Z" } as any);
      await writeConfidenceText({ root, subdir: "risks", name: "risk-a.txt", text: "risk text", generatedAt: "2026-11-17T00:00:00Z" } as any);

      const m1 = await regenerateConfidenceManifest({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      const m2 = await regenerateConfidenceManifest({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      expect(m1.schema_version).toBe("lemma.confidence.workspace/v1");
      expect(m1.artifacts.length).toBeGreaterThanOrEqual(2);
      const claim = m1.artifacts.find((a) => a.path.endsWith("claims/claim-a.json"));
      expect(claim).toBeTruthy();
      expect(claim?.id).toMatch(/^cw-/);
      expect(claim?.fingerprint).toMatch(/^sha256:/);
      expect(m1.artifacts.map((a) => a.id)).toEqual(m2.artifacts.map((a) => a.id));
      expect(m1.artifacts.map((a) => a.fingerprint)).toEqual(m2.artifacts.map((a) => a.fingerprint));

      // manifest file is complete JSON (atomic regeneration, not partially written)
      const raw = await fs.readFile(path.join(root, ".confidence", "workspace.manifest.json"), "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.artifacts.length).toBe(m1.artifacts.length);
    });
  });

  it("applies redaction before persistence across subdirectories and uses atomic/core-state reads+writes (corrupt reads raise StateError)", async () => {
    await withTempDir(async (root) => {
      await initConfidenceWorkspace({ root, generatedAt: "2026-11-17T00:00:00Z" } as any);
      const secret = "sk-SECRET_TOKEN_1234567890";
      await writeConfidenceJson({
        root,
        subdir: "traces",
        name: "trace.json",
        value: { authorization: `Bearer ${secret}`, cookie: "session=abc", nested: { password: "hunter2", api_key: "AKIA1234567890ABCDEF" } },
        generatedAt: "2026-11-17T00:00:00Z",
      } as any);
      const persisted = await fs.readFile(path.join(root, ".confidence", "traces", "trace.json"), "utf8");
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain("AKIA1234567890ABCDEF");
      expect(persisted).not.toContain("session=abc");
      expect(persisted).not.toContain("hunter2");
      expect(persisted).toMatch(/REDACTED/);

      await writeConfidenceText({ root, subdir: "decisions", name: "note.txt", text: `token=${secret}`, generatedAt: "2026-11-17T00:00:00Z" } as any);
      const note = await fs.readFile(path.join(root, ".confidence", "decisions", "note.txt"), "utf8");
      expect(note).not.toContain(secret);
      expect(note).toMatch(/REDACTED/);

      // corrupt read raises StateError (via core state readJsonFile/CorruptStateError)
      const badPath = path.join(root, ".confidence", "reviews", "bad.json");
      await fs.writeFile(badPath, "{ not valid json", "utf8");
      await expect(readConfidenceJson({ root, subdir: "reviews", name: "bad.json" } as any)).rejects.toBeInstanceOf(StateError);

      // atomic write: valid JSON written
      const good = await readConfidenceJson({ root, subdir: "traces", name: "trace.json" } as any);
      expect(good).toBeTruthy();
    });
  });
});
