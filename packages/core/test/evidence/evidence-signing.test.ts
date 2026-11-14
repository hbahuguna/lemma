import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  EvidenceStore,
  makeDeterminism,
  resetDeterminism,
  setDeterminism,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-evidence-sign-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-017 evidence signing, verification, and tamper hold", () => {
  it("signs manifests deterministically for same run id and verifies clean state", async () => {
    await withTempDir(async (root) => {
      const det = makeDeterminism({ clockMode: "frozen", frozenClock: "2026-11-14T00:00:00Z", seed: 1 });
      const prev = setDeterminism(det);
      try {
        const store = new EvidenceStore(root, "run-sign");
        await store.init();
        await store.saveText("a", "hello", "text", "", "c1");
        await store.checkpoint();
        const m1 = JSON.parse(await readFile(store.manifestPath, "utf8")) as Record<string, unknown>;
        expect(m1.signature_algorithm).toBe("HMAC-SHA256");
        expect(typeof m1.signature).toBe("string");
        expect(typeof m1.signed_at).toBe("string");

        const store2 = new EvidenceStore(root, "run-sign");
        await store2.init();
        await store2.checkpoint();
        const m2 = JSON.parse(await readFile(store.manifestPath, "utf8")) as Record<string, unknown>;
        expect(m2.signature).toBe(m1.signature); // deterministic key + same payload/timestamps

        const v = await store.verify();
        expect(v.tampered).toBe(false);
        expect(v.signature_valid).toBe(true);
        expect(v.signature_error).toBe("");
        expect(v.missing).toEqual([]);
        expect(v.mismatches).toEqual([]);
        expect(v.checked).toBe(1);
        expect(v.alert.level).toBe("ok");
      } finally {
        resetDeterminism(prev);
      }
    });
  });

  it("detects artifact tamper, missing artifacts, and manifest/signature tamper", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-tamper");
      await store.init();
      const rel = await store.saveText("artifact", "hello", "text", "", "c1");
      await store.finalize({ run_id: "run-tamper" });

      // artifact content modified
      await writeFile(path.join(root, rel), "tampered", "utf8");
      let v = await store.verify();
      expect(v.tampered).toBe(true);
      expect(v.mismatches.length).toBe(1);
      expect(v.affected.some((a) => a.reason === "hash_mismatch")).toBe(true);
      expect(v.alert.level).toBe("error");

      // restore artifact, remove it
      await writeFile(path.join(root, rel), "hello", "utf8");
      await rm(path.join(root, rel));
      v = await store.verify();
      expect(v.tampered).toBe(true);
      expect(v.missing).toContain(rel);
      expect(v.affected.some((a) => a.reason === "missing")).toBe(true);

      // restore artifact, tamper manifest evidence metadata/signature mismatch
      await writeFile(path.join(root, rel), "hello", "utf8");
      const manifest = JSON.parse(await readFile(store.manifestPath, "utf8")) as Record<string, unknown>;
      (manifest.evidence as Array<Record<string, unknown>>)[0]!.description = "changed";
      await writeFile(store.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      v = await store.verify();
      expect(v.tampered).toBe(true);
      expect(v.signature_valid).toBe(false);
      expect(v.signature_error).toContain("signature");
      expect(v.affected.some((a) => a.reason === "signature_invalid")).toBe(true);
    });
  });

  it("supports injected signing key and reports unreadable/missing manifest", async () => {
    await withTempDir(async (root) => {
      const key = Buffer.from("secret-key-material");
      const store = new EvidenceStore(root, "run-key", { signingKey: key });
      await store.init();
      await store.saveText("a", "hello");
      await store.finalize({});
      const manifest = JSON.parse(await readFile(store.manifestPath, "utf8")) as Record<string, unknown>;

      // different key cannot verify same manifest
      const other = new EvidenceStore(root, "run-key", { signingKey: "different" });
      await other.init();
      let v = await other.verify();
      expect(v.tampered).toBe(true);
      expect(v.signature_valid).toBe(false);

      // same key verifies
      const same = new EvidenceStore(root, "run-key", { signingKey: key });
      await same.init();
      v = await same.verify();
      expect(v.tampered).toBe(false);
      expect(v.signature_valid).toBe(true);
      expect(manifest.signature).toBeTruthy();

      // missing manifest
      await rm(store.manifestPath);
      v = await store.verify();
      expect(v.tampered).toBe(true);
      expect(v.signature_error).toContain("missing");
    });
  });
});
