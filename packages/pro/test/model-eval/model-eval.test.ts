import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProUnavailableError, runModelEval, validateModelEvalResult } from "../../src/index.js";

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
    workspace_id: "ws_pro_eval",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_eval",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

async function writeCase(root: string, rel: string, obj: any) {
  const p = path.join(root, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

describe("LEM-163 AI model evaluation workflow", () => {
  it("rejects unlicensed invocation with ProUnavailableError", async () => {
    const root = await mkdtemp("lemma-eval-unlic-");
    tempDirs.push(root);
    await expect(runModelEval({ projectRoot: root, license: null } as any)).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("returns UNEVALUATED for every case with documented 'no endpoint configured' note when licensed but no endpoint", async () => {
    const root = await mkdtemp("lemma-eval-noep-");
    tempDirs.push(root);
    await writeCase(root, "evals/cases/a.json", { id: "c1", description: "d", input: "i", expected_business_behavior: "e", reviewed: true });
    await writeCase(root, "evals/cases/b.json", { id: "c2", description: "d2", input: "i2", expected_business_behavior: "e2", reviewed: true });
    const res = await runModelEval({ projectRoot: root, license: validLicense as any, modelConfig: null } as any);
    expect(res.schema_version).toBe("lemma.pro.model_eval_result/v1");
    expect(validateModelEvalResult(res).schema_version).toBe("lemma.pro.model_eval_result/v1");
    expect(res.endpoint_configured).toBe(false);
    expect(res.notes.join(" ")).toContain("no endpoint configured");
    expect(res.cases.every((c) => c.outcome === "UNEVALUATED")).toBe(true);
    expect(res.cases.every((c) => c.note.includes("no endpoint configured"))).toBe(true);
  });

  it("loads cases (incl. versioned fixtures), skips reviewed:false with explicit note, and records redacted evidence per case", async () => {
    const root = await mkdtemp("lemma-eval-load-");
    tempDirs.push(root);
    await writeCase(root, "evals/cases/one.json", { id: "case.pass", description: "p", input: { token: "secret-token-XYZ" }, expected_business_behavior: "ok", reviewed: true });
    await writeCase(root, "evals/cases/two.json", { id: "case.skip", description: "s", input: "x", expected_business_behavior: "y", reviewed: false });
    const res = await runModelEval({
      projectRoot: root,
      license: validLicense as any,
      modelConfig: {
        endpoint: { invoke: async () => ({ output: { text: "api_key=sk-SECRET1234567890" }, pass: true, rationale: "ok with token ghp_abcdefghijklmnopqrstuvwxyz1234567890" }) },
      },
      seed: 7,
      clock: "2026-11-16T00:00:00Z",
    } as any);
    expect(res.cases.find((c) => c.id === "case.skip")?.outcome).toBe("UNEVALUATED");
    expect(res.cases.find((c) => c.id === "case.skip")?.note).toContain("reviewed=false");
    const pass = res.cases.find((c) => c.id === "case.pass");
    expect(pass?.outcome).toBe("PASS");
    const evAbs = path.join(root, pass!.evidence_path);
    const raw = await fs.readFile(evAbs, "utf8");
    expect(raw).not.toContain("sk-SECRET1234567890");
    expect(raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    const ev = JSON.parse(raw);
    expect(ev.case_id).toBe("case.pass");
    expect(ev.fingerprint).toBe(pass!.fingerprint);
    expect(ev.judge_rationale || ev.judge_output).toBeTruthy();
  });

  it("distinguishes all six outcomes including REGRESSION/IMPROVEMENT/UNCHANGED via recorded baseline", async () => {
    const root = await mkdtemp("lemma-eval-outcomes-");
    tempDirs.push(root);
    await writeCase(root, "evals/cases/cases.json", [
      { id: "o.pass", reviewed: true, expected_business_behavior: "x" },
      { id: "o.fail", reviewed: true, expected_business_behavior: "x" },
      { id: "o.reg", reviewed: true, expected_business_behavior: "x" },
      { id: "o.imp", reviewed: true, expected_business_behavior: "x" },
      { id: "o.unch", reviewed: true, expected_business_behavior: "x" },
      { id: "o.unrev", reviewed: false, expected_business_behavior: "x" },
    ]);
    const res = await runModelEval({
      projectRoot: root,
      license: validLicense as any,
      modelConfig: {
        baselineOutcomes: { "o.reg": "PASS", "o.imp": "FAIL", "o.unch": "PASS" },
        endpoint: {
          invoke: ({ case: c }: any) => {
            if (c.id === "o.pass" || c.id === "o.unch") return { output: "ok", pass: true, rationale: "good" };
            if (c.id === "o.imp") return { output: "ok", pass: true, rationale: "fixed" };
            return { output: "bad", pass: false, rationale: "bad" }; // fail/reg
          },
        },
      },
    } as any);
    expect(res.cases.find((c) => c.id === "o.pass")?.outcome).toBe("PASS");
    expect(res.cases.find((c) => c.id === "o.fail")?.outcome).toBe("FAIL");
    expect(res.cases.find((c) => c.id === "o.reg")?.outcome).toBe("REGRESSION");
    expect(res.cases.find((c) => c.id === "o.imp")?.outcome).toBe("IMPROVEMENT");
    expect(res.cases.find((c) => c.id === "o.unch")?.outcome).toBe("UNCHANGED");
    expect(res.cases.find((c) => c.id === "o.unrev")?.outcome).toBe("UNEVALUATED");
  });

  it("is deterministic with same seed + frozen clock + same cases + stub endpoint (byte-identical evidence)", async () => {
    const root = await mkdtemp("lemma-eval-det-");
    tempDirs.push(root);
    await writeCase(root, "evals/cases/det.json", { id: "det.case", description: "det", input: { a: 1 }, expected_business_behavior: "x", reviewed: true });
    const endpoint = { invoke: ({ case: c, seed }: any) => ({ output: { echoed: c.id, seed }, pass: true, rationale: "deterministic" }) };
    const opts = { projectRoot: root, license: validLicense as any, runId: "run_det_eval", seed: 42, clock: "2026-11-16T00:00:00Z", modelConfig: { endpoint } } as any;
    const a = await runModelEval(opts);
    const evA = await fs.readFile(path.join(root, a.cases[0]!.evidence_path), "utf8");
    const b = await runModelEval(opts);
    const evB = await fs.readFile(path.join(root, b.cases[0]!.evidence_path), "utf8");
    expect(evA).toBe(evB);
    expect(a.cases[0]!.fingerprint).toBe(b.cases[0]!.fingerprint);
  });
});
