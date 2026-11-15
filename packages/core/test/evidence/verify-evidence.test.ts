import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EvidenceStore, verifyEvidence } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-verify-evidence-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-071 verify-evidence and hold-on-tamper behavior", () => {
  it("verifies clean signed evidence offline and reports ok without hold/cap", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-1");
      await store.init();
      await store.saveText("note", "hello", "text", "", "static.tests");
      await store.finalize({ status: "completed" });

      const result = await verifyEvidence(root, "run-1");
      expect(result.command).toBe("verify-evidence");
      expect(result.run_id).toBe("run-1");
      expect(result.tampered).toBe(false);
      expect(result.signature_valid).toBe(true);
      expect(result.checked).toBe(1);
      expect(result.missing).toEqual([]);
      expect(result.mismatches).toEqual([]);
      expect(result.alert.level).toBe("ok");
      expect(result.confidence_cap).toBeUndefined();
      expect(result.decision).toBeUndefined();
    });
  });

  it("detects artifact tamper and enforces hold-on-tamper", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-2");
      await store.init();
      const rel = await store.saveText("note", "hello", "text", "", "static.tests");
      await store.finalize({ status: "completed" });
      await writeFile(path.join(root, rel), "tampered", "utf8");

      const result = await verifyEvidence(root, "run-2");
      expect(result.tampered).toBe(true);
      expect(result.confidence_cap).toBe(0.0);
      expect(result.decision).toBe("hold");
      expect(result.affected.some((a) => a.path === rel && a.reason === "hash_mismatch" && a.check_id === "static.tests")).toBe(true);
      expect(result.alert.level).toBe("error");
    });
  });

  it("detects missing artifacts and manifest/signature tamper", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-3");
      await store.init();
      const rel = await store.saveText("note", "hello", "text", "", "static.tests");
      await store.finalize({ status: "completed" });

      await rm(path.join(root, rel));
      let result = await verifyEvidence(root, "run-3");
      expect(result.tampered).toBe(true);
      expect(result.decision).toBe("hold");
      expect(result.confidence_cap).toBe(0.0);
      expect(result.missing).toContain(rel);
      expect(result.affected.some((a) => a.path === rel && a.reason === "missing")).toBe(true);

      // restore artifact and tamper signature
      await writeFile(path.join(root, rel), "hello", "utf8");
      const manifest = JSON.parse(await readFile(store.manifestPath, "utf8")) as Record<string, unknown>;
      manifest.signature = "0".repeat(64);
      await writeFile(store.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      result = await verifyEvidence(root, "run-3");
      expect(result.tampered).toBe(true);
      expect(result.signature_valid).toBe(false);
      expect(result.decision).toBe("hold");
      expect(result.affected.some((a) => a.reason === "signature_invalid")).toBe(true);
    });
  });

  it("resolves run id from progress or newest evidence dir and errors when none found", async () => {
    await withTempDir(async (root) => {
      // newest evidence dir fallback (lexically last directory name)
      const s1 = new EvidenceStore(root, "run-001");
      await s1.init();
      await s1.saveText("a", "a");
      await s1.finalize({});
      const s2 = new EvidenceStore(root, "run-002");
      await s2.init();
      await s2.saveText("b", "b");
      await s2.finalize({});

      let result = await verifyEvidence(root);
      expect(result.run_id).toBe("run-002");
      expect(result.command).toBe("verify-evidence");

      // progress takes precedence when present
      await mkdir(path.join(root, ".lemma"), { recursive: true });
      await writeFile(path.join(root, ".lemma", "progress.json"), JSON.stringify({ run_id: "run-001" }), "utf8");
      result = await verifyEvidence(root);
      expect(result.run_id).toBe("run-001");
    });

    await withTempDir(async (root) => {
      const result = await verifyEvidence(root);
      expect(result.command).toBe("verify-evidence");
      expect(result.status).toBe("error");
      expect(result.error?.type).toBe("StateError");
      expect(result.error?.message).toContain("No run id or evidence directory found");
      expect(result.tampered).toBe(false);
      expect(result.decision).toBeUndefined();
      expect(result.confidence_cap).toBeUndefined();
    });
  });
});
