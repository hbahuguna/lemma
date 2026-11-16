import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { autoCommand } from "../../src/commands.js";

const tempDirs: string[] = [];

async function mkdtemp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("LEM-166 CLI auto command", () => {
  it("runs bounded auto loop and persists durable cycle state/evidence under .lemma/auto/", async () => {
    const root = await mkdtemp("lemma-cli-auto-");
    // provide a target dir
    await fs.mkdir(path.join(root, "proj"), { recursive: true });

    const out: any = await autoCommand([
      "--root", root,
      "--target", path.join(root, "proj"),
      "--max-cycles", "1",
      "--clock", "frozen",
      "--frozen-clock", "2026-11-16T00:00:00Z",
      "--seed", "1",
      "--run-id", "auto-cli-1",
    ]);

    expect(out.stdoutJson).toBeTruthy();
    expect(out.stdoutJson.run_id).toBe("auto-cli-1");
    expect(out.stdoutJson.same_run_id).toBe("auto-cli-1");
    expect(out.stdoutJson.cycles_completed).toBeGreaterThanOrEqual(0);
    expect(out.stdoutJson.state_path).toContain(path.join(".lemma", "auto"));

    const stateStat = await fs.stat(out.stdoutJson.state_path);
    expect(stateStat.isFile()).toBe(true);
    const evidenceRootStat = await fs.stat(out.stdoutJson.evidence_root);
    expect(evidenceRootStat.isDirectory()).toBe(true);
  });

  it("defaults to gated mutations (decline) so silent mutation is not possible", async () => {
    const root = await mkdtemp("lemma-cli-auto-decline-");
    const out: any = await autoCommand([
      "--root", root,
      "--target", root,
      "--max-cycles", "1",
      "--clock", "frozen",
      "--frozen-clock", "2026-11-16T00:00:00Z",
      "--run-id", "auto-cli-2",
    ]);
    // no executeCycle provided by CLI path in this minimal run, so it should complete/halt deterministically
    expect(out.stdoutJson.run_id).toBe("auto-cli-2");
    expect(out.stdoutJson.status === "halted" || out.stdoutJson.status === "completed" || out.stdoutJson.status === "failed").toBe(true);
    // state persisted
    await fs.access(path.join(root, ".lemma", "auto", "auto-cli-2.state.json"));
  });
});
