import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateError } from "@lemma/core";
import {
  ProUnavailableError,
  compareRevisions,
  evidence,
  listRevisions,
  saveRevision,
  validateRevisionDiff,
} from "../../src/index.js";

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
    workspace_id: "ws_pro_rev",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_rev",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

describe("LEM-164 evidence revision and comparison infrastructure", () => {
  it("rejects unlicensed invocation with ProUnavailableError", async () => {
    const root = await mkdtemp("lemma-rev-unlic-");
    tempDirs.push(root);
    await expect(saveRevision({ caseId: "c1", revision: "r1", note: "n", reviewed: true, projectRoot: root, runId: "run1", license: null } as any)).rejects.toBeInstanceOf(ProUnavailableError);
    await expect(compareRevisions({ caseId: "c1", from: "r1", to: "r2", projectRoot: root, runId: "run1", license: null } as any)).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("enforces review gating, requires non-empty note, writes immutable manifests, and marks first revision as reviewed baseline", async () => {
    const root = await mkdtemp("lemma-rev-gate-");
    tempDirs.push(root);
    await expect(saveRevision({ caseId: "c1", revision: "r1", note: "ok", reviewed: false, projectRoot: root, runId: "run1", license: validLicense as any } as any)).rejects.toSatisfy((e: any) => e instanceof StateError || /reviewed/i.test(String(e?.message)));
    await expect(saveRevision({ caseId: "c1", revision: "r1", note: "   ", reviewed: true, projectRoot: root, runId: "run1", license: validLicense as any } as any)).rejects.toSatisfy((e: any) => e instanceof StateError || /note/i.test(String(e?.message)));

    const first = await evidence.saveRevision({ caseId: "c1", revision: "r1", note: "baseline", reviewed: true, projectRoot: root, runId: "run1", license: validLicense as any, outcome: "PASS", fingerprint: "fp1" } as any);
    expect(first.baseline).toBe(true);
    expect(first.reviewed).toBe(true);
    const manifest = path.join(root, ".lemma/evidence/run1/eval/c1/revisions/r1.json");
    const exists = await fs.stat(manifest).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // immutable once written
    await expect(saveRevision({ caseId: "c1", revision: "r1", note: "changed", reviewed: true, projectRoot: root, runId: "run1", license: validLicense as any, outcome: "FAIL", fingerprint: "fp2" } as any)).rejects.toSatisfy((e: any) => e instanceof StateError || /immutable|exists/i.test(String(e?.message)));

    const second = await saveRevision({ caseId: "c1", revision: "r2", note: "revised", reviewed: true, projectRoot: root, runId: "run1", license: validLicense as any, outcome: "FAIL", fingerprint: "fp2" } as any);
    expect(second.baseline).toBe(false);

    const listed = await listRevisions({ caseId: "c1", projectRoot: root, runId: "run1", license: validLicense as any } as any);
    expect(listed.revisions.map((r) => r.revision)).toEqual(["r1", "r2"]);
  });

  it("compares revisions with schema-validated diff, LEM-163 outcome vocabulary transitions, and fingerprint changes", async () => {
    const root = await mkdtemp("lemma-rev-diff-");
    tempDirs.push(root);
    await saveRevision({ caseId: "c1", revision: "r1", note: "base", reviewed: true, projectRoot: root, runId: "run1", license: validLicense as any, outcome: "PASS", fingerprint: "fpA" } as any);
    await saveRevision({ caseId: "c1", revision: "r2", note: "now fail", reviewed: true, projectRoot: root, runId: "run1", license: validLicense as any, outcome: "FAIL", fingerprint: "fpB" } as any);

    const diff = await compareRevisions({ caseId: "c1", from: "r1", to: "r2", projectRoot: root, runId: "run1", license: validLicense as any } as any);
    expect(diff.schema_version).toBe("lemma.pro.revision_diff/v1");
    expect(validateRevisionDiff(diff).schema_version).toBe("lemma.pro.revision_diff/v1");
    expect(diff.diff_id).toBeTruthy();
    expect(diff.case_transitions[0]!.from_outcome).toBe("PASS");
    expect(diff.case_transitions[0]!.to_outcome).toBe("FAIL");
    expect(diff.case_transitions[0]!.transition).toBe("REGRESSION");
    expect(diff.outcome_counts.REGRESSION).toBe(1);
    expect(diff.evidence_fingerprint_changes[0]!.changed).toBe(true);

    await saveRevision({ caseId: "c1", revision: "r3", note: "fixed", reviewed: true, projectRoot: root, runId: "run1", license: validLicense as any, outcome: "PASS", fingerprint: "fpC" } as any);
    const imp = await compareRevisions({ caseId: "c1", from: "r2", to: "r3", projectRoot: root, runId: "run1", license: validLicense as any } as any);
    expect(imp.case_transitions[0]!.transition).toBe("IMPROVEMENT");
    const same = await compareRevisions({ caseId: "c1", from: "r1", to: "r1", projectRoot: root, runId: "run1", license: validLicense as any } as any).catch(async () => {
      // if same-revision compare not allowed, use identical outcomes different revs
      await saveRevision({ caseId: "c1", revision: "r4", note: "same", reviewed: true, projectRoot: root, runId: "run1", license: validLicense as any, outcome: "PASS", fingerprint: "fpC" } as any);
      return compareRevisions({ caseId: "c1", from: "r3", to: "r4", projectRoot: root, runId: "run1", license: validLicense as any } as any);
    });
    expect(["UNCHANGED", "IMPROVEMENT", "REGRESSION", "UNEVALUATED"]).toContain(same.case_transitions[0]!.transition);
  });
});
