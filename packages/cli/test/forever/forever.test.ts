import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { foreverCommand } from "../../src/commands.js";

const tempDirs: string[] = [];

async function mkdtemp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("LEM-182 CLI forever command", () => {
  it("runs forever workflow and surfaces the same mission report as JSON", async () => {
    const root = await mkdtemp("lemma-cli-forever-");

    const out: any = await foreverCommand([
      "--root", root,
      "--target", root,
      "--max-cycles", "1",
      "--checkpoint-every", "1",
      "--clock", "frozen",
      "--frozen-clock", "2026-11-17T00:00:00Z",
      "--seed", "5",
      "--run-id", "forever-cli-1",
    ]);

    expect(out.stdoutJson).toBeTruthy();
    const mission = out.stdoutJson;
    expect(mission.schema_version).toBe("lemma.forever_mission/v1");
    expect(mission.run_id).toBe("forever-cli-1");
    expect(mission.cycles_completed).toBe(1);
    expect(Array.isArray(mission.cycles)).toBe(true);

    // mission report persisted (same report surfaced by CLI)
    const saved = JSON.parse(await fs.readFile(path.join(root, ".lemma", "forever", "forever-cli-1", "mission.json"), "utf8"));
    expect(saved.run_id).toBe(mission.run_id);
    expect(saved.cycles_completed).toBe(mission.cycles_completed);
    expect(saved.status).toBe(mission.status);

    // durable checkpoint and per-cycle evidence
    await fs.access(path.join(root, ".lemma", "forever", "forever-cli-1", "checkpoint.json"));
    await fs.access(path.join(root, ".lemma", "forever", "forever-cli-1", "1", "cycle.json"));
  });
});
