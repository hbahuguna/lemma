import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  EvidenceStore,
  sha256Bytes,
  sha256File,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-evidence-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-016 hashed evidence store and checkpoint manifest", () => {
  it("stores artifacts with portable paths, hashes, metadata, dedupe, and stable naming", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-1");
      await store.init();

      const p1 = await store.saveText("My Artifact", "hello", "text", "desc", "check.a", ".txt");
      expect(p1).toBe(".lemma/evidence/run-1/My-Artifact.txt");
      const p2 = await store.saveText("My Artifact", "world", "text", "desc2", "check.a", ".txt");
      expect(p2).toBe(".lemma/evidence/run-1/My-Artifact-2.txt");

      const jsonPath = await store.saveJson("data", { ok: true }, "json", "payload", "check.b");
      expect(jsonPath).toBe(".lemma/evidence/run-1/data.json");
      const bytes = Buffer.from([1, 2, 3, 4]);
      const binPath = await store.saveBytes("blob", bytes, "binary", "bin", "check.c", ".bin");
      expect(binPath).toBe(".lemma/evidence/run-1/blob.bin");

      // replace same logical artifact path by writing exact file then recording? easier: re-save json name
      const jsonPath2 = await store.saveJson("data", { ok: false }, "json", "updated", "check.b");
      expect(jsonPath2).toBe(".lemma/evidence/run-1/data-2.json");

      const entries = store.getEntries();
      const txt1 = entries.find((e) => e.path === p1)!;
      expect(txt1.kind).toBe("text");
      expect(txt1.description).toBe("desc");
      expect(txt1.check_id).toBe("check.a");
      expect(txt1.bytes).toBe(Buffer.byteLength("hello"));
      expect(txt1.sha256).toBe(sha256Bytes("hello"));
      expect(txt1.content_type).toBe("text/plain");
      expect(typeof txt1.created_at).toBe("string");

      const absJson = path.join(root, ".lemma", "evidence", "run-1", "data.json");
      expect(await sha256File(absJson)).toBe(sha256Bytes(JSON.stringify({ ok: true }, null, 2)));

      const summary = store.summary();
      expect(summary.directory).toBe(".lemma/evidence/run-1");
      expect(summary.manifest).toBe(".lemma/evidence/run-1/manifest.json");
      expect(summary.count).toBe(entries.length);
      expect(summary.total_bytes).toBe(entries.reduce((n, e) => n + e.bytes, 0));
      expect(summary.by_kind.json).toBeGreaterThanOrEqual(2);
    });
  });

  it("supports screenshot/log helpers and checkpoint manifest atomically", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-ckpt");
      await store.init();
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
      const shot = await store.saveScreenshot("screen", png, "shot", "check.s");
      expect(shot.endsWith(".png")).toBe(true);
      await store.saveConsoleLog([{ level: "error", text: "x" }], "check.s");
      await store.saveNetworkLog([{ url: "/", status: 200 }], "check.s");

      await store.checkpoint();
      const raw = await readFile(store.manifestPath, "utf8");
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      expect(manifest.schema_version).toBe("1.0");
      expect(manifest.run_id).toBe("run-ckpt");
      expect(manifest.checkpoint).toBe(true);
      expect(Array.isArray(manifest.evidence)).toBe(true);
      expect((manifest.summary as { count: number }).count).toBe(store.getEntries().length);
    });
  });

  it("reconciles rerun checks and recovers completed-check artifacts missing from manifest", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-rec");
      await store.init();
      const keptPath = await store.saveText("kept", "ok", "text", "", "check.keep");
      const rerunPath = await store.saveText("rerun", "old", "text", "", "check.rerun");
      await store.checkpoint();

      // simulate damage: manifest loses kept entry but file still on disk and check completed
      const recoveredRel = ".lemma/evidence/run-rec/recovered-on-disk.txt";
      await writeFile(path.join(root, recoveredRel), "disk", "utf8");

      // rewrite manifest to only include rerun entry (losing kept) to force recovery behavior
      const damaged = {
        schema_version: "1.0",
        run_id: "run-rec",
        generated_at: "2026-11-14T00:00:00Z",
        checkpoint: true,
        evidence: store.getEntries().filter((e) => e.path === rerunPath),
        summary: store.summary(),
      };
      await writeFile(store.manifestPath, JSON.stringify(damaged, null, 2), "utf8");

      const fresh = new EvidenceStore(root, "run-rec");
      await fresh.reconcile([
        { id: "check.keep", status: CheckStatus.PASSED, evidence: [keptPath, recoveredRel] },
        { id: "check.rerun", status: CheckStatus.PLANNED, evidence: [rerunPath] },
      ]);
      const entries = fresh.getEntries();
      expect(entries.some((e) => e.path === rerunPath)).toBe(false);
      expect(entries.some((e) => e.path === keptPath && e.check_id === "check.keep")).toBe(true);
      const recovered = entries.find((e) => e.path === recoveredRel);
      expect(recovered).toBeDefined();
      expect(recovered!.kind).toBe("recovered");
      expect(recovered!.sha256).toBe(sha256Bytes("disk"));

      const manifest = JSON.parse(await readFile(store.manifestPath, "utf8")) as { checkpoint: boolean };
      expect(manifest.checkpoint).toBe(true);
    });
  });

  it("finalizes manifest with metadata/hash and enforces path safety", async () => {
    await withTempDir(async (root) => {
      const store = new EvidenceStore(root, "run-fin");
      await store.init();
      await store.saveText("a", "hello", "text", "", "c1");
      const finalized = await store.finalize({ run_id: "run-fin", status: "completed" });
      expect(finalized.checkpoint).toBeUndefined();
      expect(finalized.run).toEqual({ run_id: "run-fin", status: "completed" });
      expect(finalized.manifest_path).toBe(".lemma/evidence/run-fin/manifest.json");
      expect(typeof finalized.manifest_sha256).toBe("string");
      const raw = await readFile(store.manifestPath, "utf8");
      expect(finalized.manifest_sha256).toBe(sha256Bytes(raw));

      // recovery must refuse traversal/outside-root paths
      const fresh = new EvidenceStore(root, "run-safe");
      await fresh.init();
      await expect(
        fresh.reconcile([
          { id: "c", status: CheckStatus.PASSED, evidence: ["../outside.txt"] },
        ]),
      ).resolves.toBeUndefined();
      expect(fresh.getEntries().find((e) => e.path.includes("outside"))).toBeUndefined();
    });
  });
});
