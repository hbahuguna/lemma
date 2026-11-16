import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProUnavailableError, saveRevision } from "@lemma/pro";
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
    workspace_id: "ws_pro_rev_cli",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_rev_cli",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

describe("LEM-164 CLI pro eval revisions/compare", () => {
  it("returns typed ProUnavailableError when unlicensed (no reads/writes)", async () => {
    const root = await mkdtemp("lemma-cli-rev-unlic-");
    tempDirs.push(root);
    await expect(proCommand(["eval", "revisions", "--case", "c1", "--root", root])).rejects.toBeInstanceOf(ProUnavailableError);
    await expect(proCommand(["eval", "compare", "--case", "c1", "--from", "r1", "--to", "r2", "--root", root])).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("returns revision list and compare diff JSON to stdout (read-only)", async () => {
    const root = await mkdtemp("lemma-cli-rev-");
    tempDirs.push(root);
    await saveRevision({ caseId: "c1", revision: "r1", note: "base", reviewed: true, projectRoot: root, runId: "run1", license: validLicense as any, outcome: "PASS", fingerprint: "fp1" } as any);
    await saveRevision({ caseId: "c1", revision: "r2", note: "regressed", reviewed: true, projectRoot: root, runId: "run1", license: validLicense as any, outcome: "FAIL", fingerprint: "fp2" } as any);
    const licFile = path.join(root, "lic.json");
    await fs.writeFile(licFile, JSON.stringify(validLicense), "utf8");

    const listed = await proCommand(["eval", "revisions", "--case", "c1", "--run-id", "run1", "--root", root, "--entitlement-file", licFile]) as any;
    expect(listed.stdoutJson.case_id).toBe("c1");
    expect(Array.isArray(listed.stdoutJson.revisions)).toBe(true);
    expect(listed.stdoutJson.revisions.length).toBe(2);

    const diff = await proCommand(["eval", "compare", "--case", "c1", "--from", "r1", "--to", "r2", "--run-id", "run1", "--root", root, "--entitlement-file", licFile]) as any;
    expect(diff.stdoutJson.schema_version).toBe("lemma.pro.revision_diff/v1");
    expect(diff.stdoutJson.case_transitions[0].transition).toBe("REGRESSION");
  });
});
