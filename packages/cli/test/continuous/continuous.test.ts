import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { continuousCommand } from "../../src/commands.js";

const tempDirs: string[] = [];
async function mkdtemp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("LEM-194 CLI continuous command", () => {
  it("runs each trigger and writes durable history under .lemma/continuous/<trigger>/", async () => {
    const root = await mkdtemp("lemma-cli-cont-");
    for (const trigger of ["pr", "nightly", "scheduled"]) {
      const out: any = await continuousCommand(["--trigger", trigger, "--root", root]);
      expect(out.stdoutJson?.trigger).toBe(trigger);
      expect(out.stdoutJson?.entry?.schema_version).toBe("lemma.continuous_history/v1");
      await fs.access(path.join(root, ".lemma", "continuous", trigger, "latest.json"));
      const histDir = path.join(root, ".lemma", "continuous", trigger, "history");
      const files = await fs.readdir(histDir);
      expect(files.some((f) => f.endsWith(".json"))).toBe(true);
    }
  });

  it("supports bounded PR subset and full-catalog nightly scope; scheduled cron documented in workflow", async () => {
    const root = await mkdtemp("lemma-cli-cont-scope-");
    const pr: any = await continuousCommand(["--trigger", "pr", "--root", root, "--pr-subset", "static.integrity,test.functionality"]);
    expect(pr.stdoutJson.entry.scope.mode).toBe("bounded_subset");
    expect(pr.stdoutJson.entry.scope.check_ids).toEqual(["static.integrity", "test.functionality"]);

    const nightly: any = await continuousCommand(["--trigger", "nightly", "--root", root]);
    expect(nightly.stdoutJson.entry.scope.mode).toBe("full_default_plus_promoted_regressions");

    // scheduled runs are documented with a supported cron example
    const nightlyWf = await fs.readFile(fileURLToPath(new URL("../../../../.github/workflows/nightly.yml", import.meta.url)), "utf8");
    expect(nightlyWf).toMatch(/schedule:/);
    expect(nightlyWf).toMatch(/cron:\s*"0 3 \* \* \*"/);
    expect(nightlyWf).toMatch(/full default catalog plus promoted regressions/i);

    const prWf = await fs.readFile(fileURLToPath(new URL("../../../../.github/workflows/pr-validate.yml", import.meta.url)), "utf8");
    expect(prWf).toMatch(/bounded subset/i);
    expect(prWf).toMatch(/marker-based PR (summary|comment)/i);
  });
});
