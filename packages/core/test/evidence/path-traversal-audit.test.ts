import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CheckStatus, EvidenceStore, sha256Bytes } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-evidence-traversal-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-128 untrusted evidence path and traversal audit", () => {
  it("reconcile/recovery refuses traversal and absolute paths without reading outside root", async () => {
    await withTempDir(async (root) => {
      const outside = path.join(path.dirname(root), `outside-secret-${path.basename(root)}.txt`);
      await writeFile(outside, "TOP_SECRET_OUTSIDE", "utf8");
      try {
        const absInsideButAbsolute = path.join(root, "abs-inside.txt");
        await writeFile(absInsideButAbsolute, "inside-by-absolute", "utf8");

        const store = new EvidenceStore(root, "run-trav");
        await store.init();
        await store.reconcile([
          {
            id: "c1",
            status: CheckStatus.PASSED,
            evidence: [
              "../outside-secret.txt",
              "../../etc/passwd",
              outside,
              absInsideButAbsolute, // absolute path form should not be accepted as portable relative evidence
              ".lemma/evidence/run-trav/../..//../outside-secret.txt",
            ],
          },
        ]);

        const entries = store.getEntries();
        expect(entries.length).toBe(0);
        const serialized = JSON.stringify(entries);
        expect(serialized).not.toContain("TOP_SECRET_OUTSIDE");
        expect(serialized).not.toContain("inside-by-absolute");
      } finally {
        await rm(outside, { force: true });
      }
    });
  });

  it("verify treats poisoned manifest paths as missing/affected and does not read outside root", async () => {
    await withTempDir(async (root) => {
      const outside = path.join(path.dirname(root), `outside-verify-${path.basename(root)}.txt`);
      await writeFile(outside, "OUTSIDE_VERIFY_SECRET", "utf8");
      try {
        const store = new EvidenceStore(root, "run-poison");
        await store.init();
        const rel = await store.saveText("ok", "safe", "text", "", "c1");
        await store.finalize({});

        const manifest = JSON.parse(await readFile(store.manifestPath, "utf8")) as Record<string, unknown>;
        const evidence = (manifest.evidence as Array<Record<string, unknown>>) ?? [];
        evidence.push(
          {
            path: "../" + path.basename(outside),
            kind: "text",
            description: "poisoned traversal",
            check_id: "evil",
            bytes: Buffer.byteLength("OUTSIDE_VERIFY_SECRET"),
            sha256: sha256Bytes("OUTSIDE_VERIFY_SECRET"),
            content_type: "text/plain",
            created_at: "2026-11-14T00:00:00Z",
          },
          {
            path: outside,
            kind: "text",
            description: "poisoned absolute",
            check_id: "evil",
            bytes: 1,
            sha256: "0".repeat(64),
            content_type: "text/plain",
            created_at: "2026-11-14T00:00:00Z",
          },
        );
        manifest.evidence = evidence;
        await writeFile(store.manifestPath, JSON.stringify(manifest, null, 2), "utf8");

        const result = await store.verify();
        // Manifest tamper/signature invalid is expected after direct edit; critical audit property:
        // unsafe paths must not be verified as valid inside-root artifacts and outside secrets must not leak.
        expect(result.tampered).toBe(true);
        expect(result.mismatches.some((m) => String(m.path) === path.basename(outside))).toBe(false);
        expect(result.affected.some((a) => a.path === "../" + path.basename(outside))).toBe(true);
        expect(result.affected.some((a) => a.path === outside)).toBe(true);

        const affectedForUnsafe = result.affected.filter((a) => a.path === "../" + path.basename(outside) || a.path === outside);
        expect(affectedForUnsafe.every((a) => a.reason === "missing")).toBe(true);

        // Legitimate in-root evidence remains readable/checkable; it must not be misclassified as missing/mismatched due to unsafe entries.
        expect(result.missing).not.toContain(rel);
        expect(result.mismatches.some((m) => String(m.path) === rel)).toBe(false);

        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("OUTSIDE_VERIFY_SECRET");
      } finally {
        await rm(outside, { force: true });
      }
    });
  });

  it("loads and verifies only safe manifest entries and keeps normal evidence portable", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-safe-load");
      await store.init();
      const rel = await store.saveText("note", "hello", "text", "", "c1");
      await store.checkpoint();

      const fresh = new EvidenceStore(root, "run-safe-load");
      await fresh.init();
      expect(fresh.getEntries().some((e) => e.path === rel)).toBe(true);
      const v = await fresh.verify();
      expect(v.tampered).toBe(false);
      expect(v.checked).toBe(1);
      expect(v.missing).toEqual([]);
    });
  });
});
