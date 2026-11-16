import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runBrowserInspection } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-browser-cmd-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-167 browser inspection command (core)", () => {
  it("writes durable inspection evidence under .lemma/evidence/<run_id>/browser/ and scopes checks", async () => {
    await withTempDir(async (root) => {
      const result = await runBrowserInspection({
        target: "https://example.com",
        checks: ["browser.load"],
        runId: "run-browser-core-1",
        root,
        options: { noBrowser: true } as any,
      } as any);

      expect(result.run_id).toBe("run-browser-core-1");
      expect(result.scoped_checks).toEqual(["browser.load"]);
      expect(result.evidence_dir).toContain(path.join(".lemma", "evidence", "run-browser-core-1", "browser"));

      const inspectionPath = path.join(root, ".lemma", "evidence", "run-browser-core-1", "browser", "inspection.json");
      const raw = await fs.readFile(inspectionPath, "utf8");
      const persisted = JSON.parse(raw);
      expect(persisted.run_id).toBe("run-browser-core-1");
      expect(persisted.observations[0]?.check_id).toBe("browser.load");
      expect(persisted.observations[0]?.fix_prompt).toBeTruthy();
    });
  });

  it("blocked browser-unavailable run has explicit blocker and no fabricated screenshot", async () => {
    await withTempDir(async (root) => {
      const result = await runBrowserInspection({
        target: "https://example.com",
        checks: ["browser.load", "browser.console"],
        runId: "run-browser-core-blocked",
        root,
        options: { noBrowser: true } as any,
      } as any);

      expect(result.status).toBe("blocked");
      expect(result.blocked).toBe(true);
      expect(result.blocker?.reason || result.observations[0]?.blocker?.reason).toBeTruthy();
      for (const obs of result.observations) {
        expect(obs.evidence?.screenshot ?? null).toBeNull();
      }
    });
  });
});
