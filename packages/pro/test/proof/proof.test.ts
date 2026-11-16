import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LeanProofBackend,
  ProUnavailableError,
  detectProofStaleness,
  readPropertyProofResult,
  runPropertyProof,
  type ProofBackend,
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
    workspace_id: "ws_pro_proof",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_proof",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

describe("LEM-158 property proof workflow", () => {
  it("rejects unlicensed invocation with ProUnavailableError and no partial execution/evidence", async () => {
    const root = await mkdtemp("lemma-proof-unlicensed-");
    tempDirs.push(root);
    await expect(
      runPropertyProof({
        property: "x > 0",
        target: root,
        root,
        license: null,
      } as any),
    ).rejects.toBeInstanceOf(ProUnavailableError);
    const evidenceDir = path.join(root, ".lemma", "evidence");
    const exists = await fs.stat(evidenceDir).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("returns UNPROVED with documented 'no backend configured' note when licensed but backend missing", async () => {
    const root = await mkdtemp("lemma-proof-nobackend-");
    tempDirs.push(root);
    const result = await runPropertyProof({
      property: "for all inputs, f(x) >= 0",
      target: root,
      scope: { files: ["src/f.ts"] },
      assumptions: ["inputs are integers"],
      backend: null,
      license: validLicense as any,
      root,
      runId: "run_proof_nb",
      proofId: "proof_nb",
    });
    expect(result.status).toBe("UNPROVED");
    expect(result.notes.join(" ")).toContain("no backend configured");
    expect(result.backend?.configured).toBe(false);
  });

  it("produces PROVED and COUNTEREXAMPLE statuses via pluggable backends and records evidence linked from report", async () => {
    const root = await mkdtemp("lemma-proof-statuses-");
    tempDirs.push(root);

    const provedBackend: ProofBackend = {
      id: "test-proved",
      name: "Test Proved Backend",
      description: "deterministic proved backend",
      run: () => ({ status: "PROVED", artifact: "proof artifact: qed", transcript: "proof transcript ok" }),
    };
    const proved = await runPropertyProof({
      property: "sum is associative",
      target: root,
      scope: { symbols: ["sum"] },
      assumptions: ["integers"],
      backend: provedBackend,
      license: validLicense as any,
      root,
      runId: "run_proof_proved",
      proofId: "proof_proved",
    });
    expect(proved.status).toBe("PROVED");
    expect(proved.schema_version).toBe("lemma.pro.proof/v1");
    expect(proved.report.blockers).toEqual([]);
    expect(proved.evidence_refs.length).toBeGreaterThan(0);

    for (const rel of [proved.evidence.artifact, proved.evidence.scope_assumptions, proved.evidence.transcript, proved.evidence.result]) {
      const exists = await fs.stat(path.join(root, rel)).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    }
    const scopeRecord = JSON.parse(await fs.readFile(path.join(root, proved.evidence.scope_assumptions), "utf8"));
    expect(scopeRecord.scope.target_hash).toBeTruthy();
    expect(scopeRecord.assumptions.items).toContain("integers");

    const cexBackend: ProofBackend = {
      id: "test-cex",
      name: "Test Counterexample Backend",
      description: "deterministic counterexample backend",
      run: () => ({ status: "COUNTEREXAMPLE", artifact: "counterexample: x = -1", transcript: "found counterexample" }),
    };
    const cex = await runPropertyProof({
      property: "f(x) > 0",
      target: root,
      scope: { files: ["f.ts"] },
      assumptions: [],
      backend: cexBackend,
      license: validLicense as any,
      root,
      runId: "run_proof_cex",
      proofId: "proof_cex",
    });
    expect(cex.status).toBe("COUNTEREXAMPLE");
    expect(cex.counterexample?.artifact_path).toBe(cex.evidence.artifact);
    // COUNTEREXAMPLE surfaced as blocker in report, not finding
    expect(cex.report.findings).toEqual([]);
    expect(cex.report.blockers.length).toBe(1);
    expect(cex.report.blockers[0]!.kind).toBe("proof_counterexample");
    expect(cex.report.blockers[0]!.evidence).toContain(cex.evidence.artifact);
    expect(JSON.stringify(cex.report.blockers[0])).toContain("property does not hold");
  });

  it("detects STALE when target/scope hash changes (documented mechanism) and marks result STALE on recompute", async () => {
    const root = await mkdtemp("lemma-proof-stale-");
    tempDirs.push(root);
    const targetFile = path.join(root, "target.txt");
    await fs.writeFile(targetFile, "v1\n", "utf8");

    const provedBackend: ProofBackend = {
      id: "test-proved",
      name: "Test Proved Backend",
      description: "deterministic",
      run: () => ({ status: "PROVED", artifact: "ok", transcript: "ok" }),
    };
    const first = await runPropertyProof({
      property: "file is stable",
      target: targetFile,
      backend: provedBackend,
      license: validLicense as any,
      root,
      runId: "run_proof_stale",
      proofId: "proof_stale",
    });
    expect(first.status).toBe("PROVED");
    expect(first.scope.target_hash).toBeTruthy();

    // change target -> staleness should be detected
    await fs.writeFile(targetFile, "v2 changed\n", "utf8");
    const staleCheck = await detectProofStaleness({ target: targetFile, scope: first.scope }, root);
    expect(staleCheck.stale).toBe(true);
    expect(String(staleCheck.reason || "")).toContain("hash");

    const recomputed = await runPropertyProof({
      property: "file is stable",
      target: targetFile,
      scope: { target_hash: first.scope.target_hash }, // recorded hash
      backend: provedBackend,
      license: validLicense as any,
      root,
      runId: "run_proof_stale",
      proofId: "proof_stale",
      recomputeStaleness: true,
    });
    expect(recomputed.status).toBe("STALE");
    expect(String(recomputed.stale_reason || recomputed.notes.join(" "))).toContain("hash");
  });

  it("redacts transcript secrets before persistence and supports backend-unavailable degradation note", async () => {
    const root = await mkdtemp("lemma-proof-redact-");
    tempDirs.push(root);
    const backend: ProofBackend = {
      id: "test-secret",
      name: "Secret Backend",
      description: "emits secret-like transcript",
      run: () => ({ status: "UNPROVED", artifact: "none", transcript: "token=ghp_abcdefghijklmnopqrstuvwxyz1234567890" }),
    };
    const result = await runPropertyProof({
      property: "p",
      target: root,
      backend,
      license: validLicense as any,
      root,
      runId: "run_proof_redact",
      proofId: "proof_redact",
    });
    const transcript = await fs.readFile(path.join(root, result.evidence.transcript), "utf8");
    expect(transcript).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");

    // unavailable backend string -> UNPROVED with backend unavailable note
    const unavailable = await runPropertyProof({
      property: "p",
      target: root,
      backend: "missing-backend",
      license: validLicense as any,
      root,
      runId: "run_proof_unavail",
      proofId: "proof_unavail",
    });
    expect(unavailable.status).toBe("UNPROVED");
    expect(unavailable.notes.join(" ")).toContain("backend unavailable");

    // initial supported/documented backend exists
    const lean = new LeanProofBackend();
    expect(lean.id).toBe("lean");
  });

  it("can read persisted proof result and evidence is linked from result/report", async () => {
    const root = await mkdtemp("lemma-proof-read-");
    tempDirs.push(root);
    const result = await runPropertyProof({
      property: "q",
      target: root,
      backend: null,
      license: validLicense as any,
      root,
      runId: "run_proof_read",
      proofId: "proof_read",
    });
    const loaded = await readPropertyProofResult(root, result.run_id, result.proof_id);
    expect(loaded.proof_id).toBe(result.proof_id);
    expect(loaded.report.proof.evidence_refs).toEqual(result.evidence_refs);
  });
});
