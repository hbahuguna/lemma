import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NotOptedInError,
  ProUnavailableError,
  pushToTestRail,
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
    workspace_id: "ws_pro_tr",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_tr",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

async function writeTrustStore(root: string, ref: string, secret: string) {
  const p = path.join(root, ".lemma", "integrations", "testrail_trust.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify({ secrets: { [ref]: secret } }, null, 2), "utf8");
  return p;
}

describe("LEM-162 TestRail integration flow", () => {
  it("rejects unlicensed invocation with ProUnavailableError", async () => {
    const root = await mkdtemp("lemma-tr-unlic-");
    tempDirs.push(root);
    await expect(pushToTestRail({
      report: { run_id: "r1", findings: [] },
      project: "P1",
      config: { testRail: { enabled: true, credentialRef: "env:TOK" }, pushTestRail: true },
      projectRoot: root,
      license: null,
    } as any)).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("enforces explicit opt-in and returns NotOptedInError when missing", async () => {
    const root = await mkdtemp("lemma-tr-optin-");
    tempDirs.push(root);
    await writeTrustStore(root, "tr", "supersecret");
    const base = {
      report: { run_id: "r1", findings: [{ id: "f1", title: "t", severity: "high" }] },
      project: "P1",
      projectRoot: root,
      license: validLicense as any,
    };
    await expect(pushToTestRail({ ...base, config: { testRail: { enabled: false, credentialRef: "tr" }, pushTestRail: true } } as any)).rejects.toBeInstanceOf(NotOptedInError);
    await expect(pushToTestRail({ ...base, config: { testRail: { enabled: true, credentialRef: "tr" }, pushTestRail: false } } as any)).rejects.toBeInstanceOf(NotOptedInError);
    await expect(pushToTestRail({ ...base, config: { testRail: { enabled: true, credentialRef: "tr" } } } as any)).rejects.toBeInstanceOf(NotOptedInError);

    const ok = await pushToTestRail({
      ...base,
      config: { testRail: { enabled: true, credentialRef: "tr" } },
      agentLoopConfirmation: true,
    } as any);
    expect(ok.status).toBe("completed");
  });

  it("pushes, redacts payloads/transcripts, and records manifest under .lemma/evidence/<run_id>/testrail/", async () => {
    const root = await mkdtemp("lemma-tr-manifest-");
    tempDirs.push(root);
    const secret = "tr_secret_TOKEN_123456789";
    await writeTrustStore(root, "tr", secret);
    const report = {
      run_id: "run_tr_1",
      findings: [
        { id: "f1", title: "Leak", severity: "high", description: `Authorization: Bearer ${secret}` },
        { id: "f2", title: "Other", severity: "medium", description: "ok" },
      ],
    };
    const result = await pushToTestRail({
      report,
      project: "P1",
      projectRoot: root,
      license: validLicense as any,
      now: () => "2026-11-16T00:00:00Z",
      config: {
        testRail: { enabled: true, credentialRef: "tr", baseUrl: "https://tr.example" },
        pushTestRail: true,
        transport: async ({ request }) => {
          const text = JSON.stringify(request.payload);
          expect(text).not.toContain(secret);
          return { ok: true, status: 201, case_id: request.finding_id === "f1" ? "C1" : "C2", result_id: request.finding_id === "f1" ? "R1" : "R2" };
        },
      },
    } as any);

    expect(result.status).toBe("completed");
    expect(result.created_case_ids).toEqual(["C1", "C2"]);
    expect(result.created_result_ids).toEqual(["R1", "R2"]);
    expect(result.manifest_path).toBe(".lemma/evidence/run_tr_1/testrail/push-manifest.json");

    const manifestAbs = path.join(root, result.manifest_path!);
    const rawManifest = await fs.readFile(manifestAbs, "utf8");
    expect(rawManifest).not.toContain(secret);
    const manifest = JSON.parse(rawManifest);
    expect(manifest.schema_version).toBe("lemma.pro.testrail/v1");
    expect(Array.isArray(manifest.transcript)).toBe(true);
  });

  it("surfaces network/4xx/5xx failures as typed errors, records partial push state, and does not fail run", async () => {
    const root = await mkdtemp("lemma-tr-partial-");
    tempDirs.push(root);
    await writeTrustStore(root, "tr", "tok");
    const report = {
      run_id: "run_tr_partial",
      findings: [
        { id: "f1", title: "A", severity: "high" },
        { id: "f2", title: "B", severity: "medium" },
        { id: "f3", title: "C", severity: "low" },
      ],
    };
    const result = await pushToTestRail({
      report,
      project: "P1",
      projectRoot: root,
      license: validLicense as any,
      config: {
        testRail: { enabled: true, credentialRef: "tr" },
        pushTestRail: true,
        transport: async ({ request }) => {
          if (request.finding_id === "f1") return { ok: true, status: 201, case_id: "C10", result_id: "R10" };
          if (request.finding_id === "f2") throw new Error("network down");
          return { ok: false, status: 500, error: { type: "http_error", code: "http_500", message: "HTTP 500", status: 500 } };
        },
      },
    } as any);

    expect(result.status).toBe("partial");
    expect(result.created_case_ids).toEqual(["C10"]);
    expect(result.errors.length).toBe(2);
    expect(result.items.find((x) => x.finding_id === "f2")?.error?.message).toContain("network down");
    expect(result.items.find((x) => x.finding_id === "f3")?.error?.status).toBe(500);

    const allFail = await pushToTestRail({
      report: { run_id: "run_tr_fail", findings: [{ id: "x1", title: "X" }] },
      project: "P1",
      projectRoot: root,
      license: validLicense as any,
      config: {
        testRail: { enabled: true, credentialRef: "tr" },
        pushTestRail: true,
        transport: async () => ({ ok: false, status: 401, error: { type: "http_error", code: "http_401", message: "Unauthorized", status: 401 } }),
      },
    } as any);
    expect(allFail.status).toBe("failed");
    expect(allFail.errors[0]!.code).toBe("http_401");
  });
});
