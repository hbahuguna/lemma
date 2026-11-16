import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProUnavailableError, historyBuild, inventoryBuild } from "@lemma/pro";
import { proCommand } from "../../src/commands.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const validLicense = {
  verification: {
    valid: true,
    reason: "ok",
    workspace_id: "ws_pro_hist_cli",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_hist_cli",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

describe("LEM-160 CLI pro history", () => {
  it("returns typed ProUnavailableError when unlicensed (no reads/writes)", async () => {
    const root = await mkdtemp("lemma-cli-hist-unlic-");
    tempDirs.push(root);
    await expect(proCommand(["history", "show", "--window", "5", "--root", root])).rejects.toBeInstanceOf(ProUnavailableError);
    const histPath = path.join(root, ".lemma", "pro", "quality-history.json");
    const exists = await fs.stat(histPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("`lemma pro history show --window <n>` returns history JSON to stdout (read-only)", async () => {
    const root = await mkdtemp("lemma-cli-hist-");
    tempDirs.push(root);
    const runs = [
      { run_id: "r1", results: [{ id: "a", status: "failed", persona: "functional", evidence: ["1"] }] },
      { run_id: "r2", results: [{ id: "a", status: "passed", persona: "functional", evidence: ["2"] }] },
    ];
    const inv = await inventoryBuild({ projectRoot: root, runs, license: validLicense as any });
    await historyBuild({ projectRoot: root, inventory: inv, window: 2, license: validLicense as any });
    const licFile = path.join(root, "lic.json");
    await fs.writeFile(licFile, JSON.stringify(validLicense), "utf8");

    const shown = await proCommand(["history", "show", "--window", "2", "--root", root, "--entitlement-file", licFile]) as any;
    expect(shown.stdoutJson.schema_version).toBe("lemma.pro.quality_history/v1");
    expect(shown.stdoutJson.window).toBe(2);
    expect(Array.isArray(shown.stdoutJson.score_trend)).toBe(true);
    expect(Array.isArray(shown.stdoutJson.decision_trend)).toBe(true);
    expect(Array.isArray(shown.stdoutJson.coverage_trend)).toBe(true);
    expect(Array.isArray(shown.stdoutJson.findings_by_severity_trend)).toBe(true);
    expect(Array.isArray(shown.stdoutJson.blocker_trend)).toBe(true);
    expect(shown.stdoutJson.check_status_changes).toBeTruthy();
  });
});
