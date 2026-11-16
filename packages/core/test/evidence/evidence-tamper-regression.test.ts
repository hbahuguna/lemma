import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EvidenceStore, sha256Bytes, verifyEvidence } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-evidence-tamper-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-124 evidence-tamper regression suite (ported from assay)", () => {
  it("artifacts are hashed and verifiable and existing manifest is reloaded", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-1");
      await store.init();
      const textRef = await store.saveText("note", "hello", "text", "", "static.tests");
      const imageRef = await store.saveScreenshot(
        "shot",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
        "shot",
        "static.tests",
      );
      expect(textRef.endsWith("note.txt")).toBe(true);
      expect(imageRef.endsWith("shot.png")).toBe(true);
      expect(store.summary().count).toBe(2);

      const manifest = await store.finalize({ run_id: "run-1" });
      expect(manifest.manifest_path).toBe(".lemma/evidence/run-1/manifest.json");

      const verification = await store.verify();
      expect(verification.checked).toBe(2);
      expect(verification.mismatches).toEqual([]);
      expect(verification.missing).toEqual([]);
      expect(verification.tampered).toBe(false);
      expect(verification.signature_valid).toBe(true);

      const reopened = new EvidenceStore(root, "run-1");
      await reopened.init();
      expect(reopened.summary().count).toBe(1 + 1);
      expect(sha256Bytes(Buffer.from("hello"))).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
    });
  });

  it("detects tampering and deletion with affected path/check_id/reason", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-2");
      await store.init();
      const first = await store.saveText("first", "original", "text", "", "static.tests");
      const second = await store.saveText("second", "will-delete", "text", "", "static.other");
      await store.finalize({});

      await writeFile(path.join(root, first), "tampered", "utf8");
      await rm(path.join(root, second));

      const verification = await store.verify();
      expect(verification.tampered).toBe(true);
      expect(verification.missing).toEqual([second]);
      expect(verification.mismatches.length).toBe(1);
      expect(verification.mismatches[0]).toMatchObject({ path: first, check_id: "static.tests" });
      expect(verification.affected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: second, check_id: "static.other", reason: "missing" }),
          expect.objectContaining({ path: first, check_id: "static.tests", reason: "hash_mismatch" }),
        ]),
      );
      expect(verification.alert.level).toBe("error");
    });
  });

  it("detects manifest signature tamper", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-3");
      await store.init();
      await store.saveText("note", "hello", "text", "", "static.tests");
      await store.finalize({});

      const manifest = JSON.parse(await readFile(store.manifestPath, "utf8")) as Record<string, unknown>;
      manifest.signature = "0".repeat(64);
      await writeFile(store.manifestPath, JSON.stringify(manifest, null, 2), "utf8");

      const verification = await store.verify();
      expect(verification.tampered).toBe(true);
      expect(verification.signature_valid).toBe(false);
      expect(verification.affected.some((a) => a.reason === "signature_invalid")).toBe(true);
      expect(verification.alert.level).toBe("error");
    });
  });

  it("checkpoint manifests are signed and verification works offline", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-4");
      await store.init();
      await store.saveText("note", "hello", "text", "", "static.tests");
      await store.checkpoint();

      const manifest = JSON.parse(await readFile(store.manifestPath, "utf8")) as Record<string, unknown>;
      expect(typeof manifest.signature).toBe("string");
      expect(manifest.signature_algorithm).toBe("HMAC-SHA256");

      const verification = await store.verify();
      expect(verification.signature_valid).toBe(true);
      expect(verification.tampered).toBe(false);
      expect(verification.alert.level).toBe("ok");
      expect(verification.checked).toBe(1);
    });
  });

  it("verifyEvidence enforces hold-on-tamper and clean runs do not hold", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-5");
      await store.init();
      const rel = await store.saveText("note", "hello", "text", "", "static.tests");
      await store.finalize({});

      await writeFile(path.join(root, rel), "tampered", "utf8");
      const tampered = await verifyEvidence(root, "run-5");
      expect(tampered.command).toBe("verify-evidence");
      expect(tampered.tampered).toBe(true);
      expect(tampered.confidence_cap).toBe(0.0);
      expect(tampered.decision).toBe("hold");
      expect(tampered.affected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: rel, check_id: "static.tests", reason: "hash_mismatch" }),
        ]),
      );
    });

    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-6");
      await store.init();
      await store.saveText("note", "hello", "text", "", "static.tests");
      await store.finalize({});
      const clean = await verifyEvidence(root, "run-6");
      expect(clean.tampered).toBe(false);
      expect(clean.decision).toBeUndefined();
      expect(clean.confidence_cap).toBeUndefined();
      expect(clean.alert.level).toBe("ok");
    });
  });
});
