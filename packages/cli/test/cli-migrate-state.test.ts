import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runCli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { code, stdout, stderr };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("LEM-138 migrate-state and legacy read shim", () => {
  it("reads legacy .harness progress/history when .lemma is absent (read shim)", async () => {
    const root = await mkdtemp("lemma-migrate-read-");
    tempDirs.push(root);
    const legacy = path.join(root, ".harness");
    await fs.mkdir(path.join(legacy, "evidence", "run-1"), { recursive: true });
    await fs.writeFile(
      path.join(legacy, "progress.json"),
      JSON.stringify({
        run_id: "run-1",
        status: "completed",
        workflow_id: "release-confidence",
        workflow_version: "1.0",
        target: { raw: ".", kind: "directory" },
        intent: "legacy",
        current_phase: "confidence_scoring",
        checks: [],
        findings: [],
        blockers: [],
        confidence: { score: 88, gate: { status: "pass" } },
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(legacy, "history.json"),
      JSON.stringify({
        schema_version: "quality-harness.history/v1",
        runs: [{ run_id: "run-1", status: "completed", decision: "ship", recorded_at: "2026-11-16T00:00:00Z" }],
      }, null, 2),
      "utf8",
    );

    const status = await runCli(["status", "--root", root]);
    expect(status.code).toBe(0);
    const statusJson = JSON.parse(status.stdout) as Record<string, unknown>;
    expect(statusJson.status).toBe("completed");
    expect(statusJson.run_id).toBe("run-1");

    const history = await runCli(["status", "--root", root, "--all"]);
    expect(history.code).toBe(0);
    const histJson = JSON.parse(history.stdout) as { runs?: Array<{ run_id?: string }> };
    expect(histJson.runs?.some((r) => r.run_id === "run-1")).toBe(true);
  });

  it("migrate-state dry-run reports migration without writing .lemma", async () => {
    const root = await mkdtemp("lemma-migrate-dry-");
    tempDirs.push(root);
    const legacy = path.join(root, ".harness");
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "progress.json"), JSON.stringify({ run_id: "r1", status: "completed" }), "utf8");

    const res = await runCli(["migrate-state", "--root", root, "--dry-run"]);
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(json.status).toBe("dry_run");
    expect(json.migrated).toBe(false);
    await expect(fs.access(path.join(root, ".lemma"))).rejects.toBeTruthy();
  });

  it("migrate-state copies legacy state to .lemma and refuses overwrite without --force", async () => {
    const root = await mkdtemp("lemma-migrate-copy-");
    tempDirs.push(root);
    const legacy = path.join(root, ".harness");
    await fs.mkdir(path.join(legacy, "evidence", "run-2"), { recursive: true });
    await fs.writeFile(path.join(legacy, "progress.json"), JSON.stringify({ run_id: "run-2", status: "completed" }), "utf8");
    await fs.writeFile(path.join(legacy, "evidence", "run-2", "note.txt"), "evidence", "utf8");

    const res = await runCli(["migrate-state", "--root", root]);
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(json.status).toBe("migrated");
    expect(json.migrated).toBe(true);
    await expect(fs.readFile(path.join(root, ".lemma", "progress.json"), "utf8")).resolves.toContain("run-2");
    await expect(fs.readFile(path.join(root, ".lemma", "evidence", "run-2", "note.txt"), "utf8")).resolves.toBe("evidence");

    const again = await runCli(["migrate-state", "--root", root]);
    expect(again.code).toBe(0);
    const againJson = JSON.parse(again.stdout) as Record<string, unknown>;
    expect(againJson.status).toBe("exists");
    expect(againJson.migrated).toBe(false);
  });
});
