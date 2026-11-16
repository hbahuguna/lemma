import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProUnavailableError, inventoryBuild } from "@lemma/pro";
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
    workspace_id: "ws_pro_inv_cli",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_inv_cli",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

describe("LEM-159 CLI pro inventory", () => {
  it("returns typed ProUnavailableError when unlicensed (no reads/writes)", async () => {
    const root = await mkdtemp("lemma-cli-inv-unlic-");
    tempDirs.push(root);
    await expect(proCommand(["inventory", "show", "--root", root])).rejects.toBeInstanceOf(ProUnavailableError);
    const invPath = path.join(root, ".lemma", "pro", "inventory.json");
    const exists = await fs.stat(invPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("`lemma pro inventory show` and `list --check` return inventory JSON to stdout (read-only)", async () => {
    const root = await mkdtemp("lemma-cli-inv-");
    tempDirs.push(root);
    await inventoryBuild({
      projectRoot: root,
      license: validLicense as any,
      runs: [{ run_id: "run_cli", results: [{ id: "static.tests", status: "passed", persona: "functional", evidence: ["e1"] }] }],
    });
    const licFile = path.join(root, "lic.json");
    await fs.writeFile(licFile, JSON.stringify(validLicense), "utf8");

    const shown = await proCommand(["inventory", "show", "--root", root, "--entitlement-file", licFile]) as any;
    expect(shown.stdoutJson.schema_version).toBe("lemma.pro.test_inventory/v1");
    expect(Array.isArray(shown.stdoutJson.checks)).toBe(true);

    const listed = await proCommand(["inventory", "list", "--check", "static.tests", "--root", root, "--entitlement-file", licFile]) as any;
    expect(listed.stdoutJson.check?.stable_id).toBe("static.tests");
    expect(listed.stdoutJson.inventory?.schema_version).toBe("lemma.pro.test_inventory/v1");
  });
});
