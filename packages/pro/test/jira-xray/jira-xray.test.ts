import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NotOptedInError,
  ProUnavailableError,
  pushToJiraXray,
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
    workspace_id: "ws_pro_jira",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_jira",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

async function writeTrustStore(root: string, ref: string, secret: string) {
  const p = path.join(root, ".lemma", "integrations", "jira_xray_trust.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify({ secrets: { [ref]: secret } }, null, 2), "utf8");
  return p;
}

describe("LEM-161 Jira/Xray integration flow", () => {
  it("rejects unlicensed invocation with ProUnavailableError (no partial execution)", async () => {
    const root = await mkdtemp("lemma-jira-unlic-");
    tempDirs.push(root);
    await expect(pushToJiraXray({
      report: { run_id: "r1", findings: [] },
      project: "PROJ",
      config: { jiraXray: { enabled: true, credentialRef: "env:TOK" }, pushJira: true },
      projectRoot: root,
      license: null,
    } as any)).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("enforces explicit opt-in (project enabled AND per-run flag/confirmation) and returns NotOptedInError", async () => {
    const root = await mkdtemp("lemma-jira-optin-");
    tempDirs.push(root);
    await writeTrustStore(root, "jira", "supersecret");
    const base = {
      report: { run_id: "r1", findings: [{ id: "f1", title: "t", severity: "high" }] },
      project: "PROJ",
      projectRoot: root,
      license: validLicense as any,
    };
    await expect(pushToJiraXray({ ...base, config: { jiraXray: { enabled: false, credentialRef: "jira", projectKey: "PROJ" }, pushJira: true } } as any)).rejects.toBeInstanceOf(NotOptedInError);
    await expect(pushToJiraXray({ ...base, config: { jiraXray: { enabled: true, credentialRef: "jira", projectKey: "PROJ" }, pushJira: false } } as any)).rejects.toBeInstanceOf(NotOptedInError);
    await expect(pushToJiraXray({ ...base, config: { jiraXray: { enabled: true, credentialRef: "jira", projectKey: "PROJ" } } } as any)).rejects.toBeInstanceOf(NotOptedInError);

    // agent-loop confirmation satisfies per-run opt-in
    const ok = await pushToJiraXray({
      ...base,
      config: { jiraXray: { enabled: true, credentialRef: "jira", projectKey: "PROJ" } },
      agentLoopConfirmation: true,
      now: () => "2026-11-16T00:00:00Z",
    } as any);
    expect(ok.status).toBe("completed");
    expect(ok.opt_in).toEqual({ project_enabled: true, per_run: true });
  });

  it("pushes findings, redacts payloads/transcripts, and records manifest under .lemma/evidence/<run_id>/jira/", async () => {
    const root = await mkdtemp("lemma-jira-manifest-");
    tempDirs.push(root);
    const secret = "ghp_SUPERSECRET1234567890abcd";
    await writeTrustStore(root, "jira", secret);
    const report = {
      run_id: "run_jira_1",
      findings: [
        { id: "f1", title: "Leak", severity: "high", description: `token=abc123 and ${secret}` },
        { id: "f2", title: "Other", severity: "medium", description: "ok" },
      ],
    };
    const result = await pushToJiraXray({
      report,
      project: "PROJ",
      projectRoot: root,
      license: validLicense as any,
      now: () => "2026-11-16T00:00:00Z",
      config: {
        jiraXray: { enabled: true, credentialRef: "jira", projectKey: "PROJ", baseUrl: "https://jira.example" },
        pushJira: true,
        transport: async ({ request }) => {
          // outbound payload passed through redaction boundary
          const text = JSON.stringify(request.payload);
          expect(text).not.toContain(secret);
          return { ok: true, status: 201, key: `PROJ-${request.finding_id === "f1" ? 1 : 2}` };
        },
      },
    } as any);

    expect(result.status).toBe("completed");
    expect(result.run_id).toBe("run_jira_1");
    expect(result.created_keys).toEqual(["PROJ-1", "PROJ-2"]);
    expect(result.manifest_path).toBe(".lemma/evidence/run_jira_1/jira/push-manifest.json");

    const manifestAbs = path.join(root, result.manifest_path!);
    const manifest = JSON.parse(await fs.readFile(manifestAbs, "utf8"));
    expect(manifest.schema_version).toBe("lemma.pro.jira_xray/v1");
    expect(manifest.issues).toEqual({ created: ["PROJ-1", "PROJ-2"], updated: [], failed: 0 });
    expect(Array.isArray(manifest.transcript)).toBe(true);
    const rawManifest = await fs.readFile(manifestAbs, "utf8");
    expect(rawManifest).not.toContain(secret);
    // plaintext credentials never written to evidence
    expect(rawManifest).not.toContain("supersecret");
  });

  it("surfaces network and 4xx/5xx failures as typed errors without failing the run, and records partial push state", async () => {
    const root = await mkdtemp("lemma-jira-partial-");
    tempDirs.push(root);
    await writeTrustStore(root, "jira", "tok");
    const report = {
      run_id: "run_jira_partial",
      findings: [
        { id: "f1", title: "A", severity: "high" },
        { id: "f2", title: "B", severity: "medium" },
        { id: "f3", title: "C", severity: "low" },
      ],
    };
    let i = 0;
    const result = await pushToJiraXray({
      report,
      project: "PROJ",
      projectRoot: root,
      license: validLicense as any,
      config: {
        jiraXray: { enabled: true, credentialRef: "jira", projectKey: "PROJ" },
        pushJira: true,
        transport: async ({ request }) => {
          i += 1;
          if (request.finding_id === "f1") return { ok: true, status: 201, key: "PROJ-10" };
          if (request.finding_id === "f2") throw new Error("network down");
          return { ok: false, status: 500, body: { message: "boom" }, error: { type: "http_error", code: "http_500", message: "HTTP 500", status: 500 } };
        },
      },
    } as any);

    expect(result.status).toBe("partial");
    expect(result.created_keys).toEqual(["PROJ-10"]);
    expect(result.errors.length).toBe(2);
    expect(result.items.find((x) => x.finding_id === "f1")?.ok).toBe(true);
    expect(result.items.find((x) => x.finding_id === "f2")?.ok).toBe(false);
    expect(String(result.items.find((x) => x.finding_id === "f2")?.error?.message)).toContain("network down");
    expect(result.items.find((x) => x.finding_id === "f3")?.error?.status).toBe(500);

    const manifest = JSON.parse(await fs.readFile(path.join(root, result.manifest_path!), "utf8"));
    expect(manifest.status).toBe("partial");
    expect(manifest.issues.failed).toBe(2);

    // all-failed case surfaces typed errors and does not throw/fail run
    const allFail = await pushToJiraXray({
      report: { run_id: "run_jira_fail", findings: [{ id: "x1", title: "X" }] },
      project: "PROJ",
      projectRoot: root,
      license: validLicense as any,
      config: {
        jiraXray: { enabled: true, credentialRef: "jira", projectKey: "PROJ" },
        pushJira: true,
        transport: async () => ({ ok: false, status: 401, error: { type: "http_error", code: "http_401", message: "Unauthorized", status: 401 } }),
      },
    } as any);
    expect(allFail.status).toBe("failed");
    expect(allFail.errors[0]!.code).toBe("http_401");
  });
});
