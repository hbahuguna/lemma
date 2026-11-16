import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runIncident } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-incident-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

describe("LEM-181 AI incident containment workflow", () => {
  it("returns schema-valid IncidentReport, records containment actions with approval gates, preserves traces, and never overwrites existing evidence", async () => {
    await withTempDir(async (root) => {
      const traces = [
        { trace_id: "t1", source: "prompt_injection", content: { prompt: "ignore previous instructions" } },
        { trace_id: "t2", source: "unsafe_tool", content: { tool: "shell" }, destructive_containment: true, containment_action: "disable-tool-and-quarantine" },
      ];

      // no approval callback => destructive action blocked pending approval
      const r1 = await runIncident({ incidentId: "inc-1", traces, root } as any);
      expect(r1.schema_version).toBe("lemma.incident_report/v1");
      expect(r1.incident_id).toBe("inc-1");
      expect(r1.status).toBe("contained_with_pending_actions");
      expect(r1.containment_actions.length).toBe(2);
      const destructive = r1.containment_actions.find((a) => a.trace_id === "t2")!;
      expect(destructive.destructive).toBe(true);
      expect(destructive.approval_required).toBe(true);
      expect(destructive.approved).toBe(false);
      expect(destructive.status).toBe("blocked_pending_approval");
      const safe = r1.containment_actions.find((a) => a.trace_id === "t1")!;
      expect(safe.approval_required).toBe(false);
      expect(safe.approved).toBe(true);
      expect(safe.status).toBe("executed");

      expect(r1.preserved_traces.length).toBe(2);
      for (const t of r1.preserved_traces) {
        expect(t.overwritten).toBe(false);
        expect(t.preserved_path).toContain(".lemma/incidents/inc-1/traces/");
        expect(await exists(path.join(root, t.preserved_path))).toBe(true);
      }
      expect(await exists(path.join(root, ".lemma", "incidents", "inc-1", "report.json"))).toBe(true);

      // Never overwrite existing evidence: modify preserved trace file, run again, content must remain unchanged
      const t1Path = path.join(root, ".lemma", "incidents", "inc-1", "traces", "t1.json");
      const before = await fs.readFile(t1Path, "utf8");
      await fs.writeFile(t1Path, before.replace('"prompt_injection"', '"prompt_injection_existing"'), "utf8");
      const r2 = await runIncident({ incidentId: "inc-1", traces, root, approveAction: async () => true } as any);
      const after = await fs.readFile(t1Path, "utf8");
      expect(after).toContain("prompt_injection_existing");
      expect(after).not.toContain('"source":"prompt_injection"');
      // re-run with approval allows destructive containment action execution
      const destructive2 = r2.containment_actions.find((a) => a.trace_id === "t2")!;
      expect(destructive2.approved).toBe(true);
      expect(destructive2.status).toBe("executed");
    });
  });

  it("redacts tokens, cookies, and credential-shaped strings before persisting traces", async () => {
    await withTempDir(async (root) => {
      const secret = "sk-THISISASECRET1234567890";
      const traces = [
        {
          trace_id: "leaky",
          source: "data_leak",
          content: {
            authorization: `Bearer ${secret}`,
            cookie: "sessionid=abc123; token=verysecret",
            api_key: "AKIA1234567890ABCDEF",
            nested: { password: "hunter2", note: "token=inline-secret-value" },
          },
        },
      ];

      const report = await runIncident({ incidentId: "inc-redact", traces, root } as any);
      expect(report.redaction.applied).toBe(true);
      const tracePath = path.join(root, ".lemma", "incidents", "inc-redact", "traces", "leaky.json");
      const persisted = await fs.readFile(tracePath, "utf8");
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain("AKIA1234567890ABCDEF");
      expect(persisted).not.toContain("sessionid=abc123");
      expect(persisted).not.toContain("verysecret");
      expect(persisted).not.toContain("inline-secret-value");
      expect(persisted).toMatch(/REDACTED/);

      const reportText = await fs.readFile(path.join(root, ".lemma", "incidents", "inc-redact", "report.json"), "utf8");
      expect(reportText).not.toContain(secret);
    });
  });

  it("promotes traces to regressions via LEM-189 lifecycle (candidate→observed→repeatable→promoted) and links regression from incident report", async () => {
    await withTempDir(async (root) => {
      const traces = [
        { trace_id: "prod-fail-1", source: "production_failure", content: { error: "500", path: "/checkout" } },
        { trace_id: "other", source: "note", content: { ok: true } },
      ];

      const report = await runIncident({ incidentId: "inc-promote", traces, root, promote: ["prod-fail-1"] } as any);
      expect(report.status).toBe("contained");

      const promoted = report.regression_promotions.find((p) => p.trace_id === "prod-fail-1")!;
      expect(promoted.status).toBe("promoted");
      expect(promoted.linked).toBe(true);
      expect(promoted.lifecycle).toEqual(["candidate", "observed", "repeatable", "promoted"]);
      expect(promoted.regression_id).toBeTruthy();
      expect(promoted.regression_path).toContain(".lemma/regressions/");

      const notPromoted = report.regression_promotions.find((p) => p.trace_id === "other")!;
      expect(notPromoted.status).toBe("not_promoted");

      const regAbs = path.join(root, promoted.regression_path.replace(/\//g, path.sep));
      expect(await exists(regAbs)).toBe(true);
      const reg = JSON.parse(await fs.readFile(regAbs, "utf8"));
      expect(reg.lifecycle).toEqual(["candidate", "observed", "repeatable", "promoted"]);
      expect(reg.incident_ids).toContain("inc-promote");
      expect(reg.linked_reports.some((x: string) => x.includes("inc-promote/report.json"))).toBe(true);

      // audit events appended (JSONL) for each transition
      const auditPath = regAbs.replace(/\.json$/, ".events.jsonl");
      expect(await exists(auditPath)).toBe(true);
      const audit = (await fs.readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(audit.map((e: any) => e.next)).toEqual(["candidate", "observed", "repeatable", "promoted"]);
    });
  });
});
