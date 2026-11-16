import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBugHunt, type BugHuntBrowserRuntime } from "../../src/bug-hunt.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("LEM-148 runBugHunt", () => {
  it("records blocked coverage gaps (never pass) when browser runtime is unavailable", async () => {
    const root = await mkdtemp("lemma-bughunt-blocked-");
    tempDirs.push(root);

    const result = await runBugHunt(
      {
        target: "https://example.test",
        root,
        maxSteps: 3,
        seed: 1,
        clock: { mode: "frozen", frozen: "2026-11-16T00:00:00Z" },
        scenarioPlan: "1) Open https://example.test\n2) Verify content\n3) Check errors",
      },
      { browserRuntime: null },
    );

    expect(result.status).toBe("blocked");
    expect(result.steps_executed).toBe(3);
    expect(result.steps.every((s) => s.status === "blocked")).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.blockers.length).toBe(3);
    expect(result.coverage_limitations.some((l) => l.kind === "browser_unavailable")).toBe(true);
    expect(result.evidence_directory).toContain(".lemma/evidence/");
    expect(result.evidence_refs.length).toBeGreaterThan(0);

    for (const ref of result.evidence_refs) {
      const abs = path.join(root, ref.replaceAll("/", path.sep));
      await expect(fs.access(abs)).resolves.toBeUndefined();
    }
  });

  it("stops cleanly at maxSteps with halted status and records limitation", async () => {
    const root = await mkdtemp("lemma-bughunt-maxsteps-");
    tempDirs.push(root);
    let calls = 0;
    const runtime: BugHuntBrowserRuntime = {
      isAvailable: () => true,
      executeStep: async ({ step }) => {
        calls += 1;
        return { status: "passed", notes: `ok-${step.step_number}` };
      },
    };

    const result = await runBugHunt(
      {
        target: "https://example.test",
        root,
        maxSteps: 2,
        seed: 7,
        clock: { mode: "frozen", frozen: "2026-11-16T00:00:00Z" },
        scenarioPlan: "1) Open /\n2) Click A\n3) Click B\n4) Click C",
      },
      { browserRuntime: runtime },
    );

    expect(calls).toBe(2);
    expect(result.steps_executed).toBe(2);
    expect(result.status).toBe("halted");
    expect(result.coverage_limitations.some((l) => l.kind === "budget" || l.kind === "halted" || /maxSteps/i.test(l.message))).toBe(true);
  });

  it("halts cleanly when wall-clock budget is exceeded", async () => {
    const root = await mkdtemp("lemma-bughunt-budget-");
    tempDirs.push(root);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const runtime: BugHuntBrowserRuntime = {
      isAvailable: () => true,
      executeStep: async ({ step }) => {
        // advance wall clock beyond budget before next iteration check
        now += 100;
        return { status: "passed", notes: `step-${step.step_number}` };
      },
    };

    const result = await runBugHunt(
      {
        target: "https://example.test",
        root,
        maxSteps: 5,
        wallClockBudgetMs: 50,
        seed: 3,
        clock: { mode: "frozen", frozen: "2026-11-16T00:00:00Z" },
        scenarioPlan: "1) Open /\n2) Click A\n3) Click B\n4) Click C",
      },
      { browserRuntime: runtime },
    );

    expect(result.status).toBe("halted");
    expect(result.steps_executed).toBeLessThan(4);
    expect(result.coverage_limitations.some((l) => l.kind === "budget" || /budget/i.test(l.message))).toBe(true);
    expect(result.steps.some((s) => s.status === "halted")).toBe(true);
  });

  it("links evidence refs and carries finding evidence refs from run evidence directory", async () => {
    const root = await mkdtemp("lemma-bughunt-evidence-");
    tempDirs.push(root);
    const runtime: BugHuntBrowserRuntime = {
      isAvailable: () => true,
      executeStep: async ({ evidence, step }) => {
        const ref = await evidence.saveText(`step-${step.step_number}-note`, "observation", "text", "note", `bug_hunt.step.${step.action}.${step.step_number}`);
        return {
          status: "failed",
          evidence_refs: [ref],
          findings: [
            {
              title: "Observed issue",
              severity: "high",
              domain: "functional",
              persona: "functional",
              strength: "observed",
              consequence: "User flow breaks.",
              location: "https://example.test",
              reproduction: "Run step",
              remediation: "Fix it",
              verification: "Re-run",
              evidence: [ref],
              tags: ["bug-hunt"],
            },
          ],
        };
      },
    };

    const result = await runBugHunt(
      {
        target: "https://example.test",
        root,
        maxSteps: 1,
        seed: 9,
        clock: { mode: "frozen", frozen: "2026-11-16T00:00:00Z" },
        scenarioPlan: "1) Open /",
      },
      { browserRuntime: runtime },
    );

    expect(result.findings.length).toBe(1);
    expect(result.findings[0]?.evidence.length).toBeGreaterThan(0);
    expect(result.evidence_refs.length).toBeGreaterThan(0);
    for (const ev of result.findings[0]?.evidence ?? []) {
      expect(result.evidence_refs).toContain(ev);
      const abs = path.join(root, ev.replaceAll("/", path.sep));
      await expect(fs.access(abs)).resolves.toBeUndefined();
    }
  });

  it("quarantines invalid persona/ownership findings and preserves invariants", async () => {
    const root = await mkdtemp("lemma-bughunt-ownership-");
    tempDirs.push(root);
    const runtime: BugHuntBrowserRuntime = {
      isAvailable: () => true,
      executeStep: async () => ({
        status: "failed",
        findings: [
          {
            title: "Bad finding",
            persona: "security", // mismatched/invalid for provided manager-only persona context below; should be quarantined
            severity: "high",
            domain: "functional",
            strength: "observed",
            consequence: "x",
            location: "x",
            reproduction: "x",
            remediation: "x",
            verification: "x",
          },
        ],
      }),
    };

    // Provide a no-check persona only to force quarantine path (manager-like)
    const result = await runBugHunt(
      {
        target: "https://example.test",
        root,
        maxSteps: 1,
        seed: 5,
        clock: { mode: "frozen", frozen: "2026-11-16T00:00:00Z" },
        scenarioPlan: "1) Open /",
        personas: [
          {
            id: "manager",
            name: "Manager",
            version: "1.0",
            domains: ["management"],
            tools: ["report_reader"],
            checks: [],
            path: "manager.md",
            role: "r",
            tools_section: "t",
            output_schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
            blocker_schema: { type: "object", required: ["persona"], properties: { persona: { type: "string" } } },
            refusal: "r",
            body: "",
            metadata: {},
          },
        ] as any,
      },
      { browserRuntime: runtime },
    );

    expect(result.findings).toHaveLength(0);
    expect(result.invalid_findings.length).toBeGreaterThan(0);
  });

  it("is deterministic for same seed/frozen clock/target/scenario", async () => {
    const root = await mkdtemp("lemma-bughunt-det-");
    tempDirs.push(root);
    const runtime: BugHuntBrowserRuntime = {
      isAvailable: () => true,
      executeStep: async ({ step, evidence }) => {
        const ref = await evidence.saveJson(`s-${step.step_number}`, { n: step.step_number }, "json", "", "bug_hunt.step.goto.1");
        return { status: "passed", evidence_refs: [ref] };
      },
    };

    const opts = {
      target: "https://example.test",
      root,
      maxSteps: 2,
      seed: 42,
      clock: { mode: "frozen" as const, frozen: "2026-11-16T00:00:00Z" },
      scenarioPlan: "1) Open /\n2) Verify content",
      runId: "bughunt_det_run",
    };

    const a = await runBugHunt(opts, { browserRuntime: runtime });
    // reset evidence dir by using different run id not possible with fixed runId in same dir; run again in fresh dir
    const root2 = await mkdtemp("lemma-bughunt-det2-");
    tempDirs.push(root2);
    const b = await runBugHunt({ ...opts, root: root2 }, { browserRuntime: runtime });

    expect(a.status).toBe(b.status);
    expect(a.steps.map((s) => [s.step_number, s.status, s.action])).toEqual(b.steps.map((s) => [s.step_number, s.status, s.action]));
    expect(a.evidence_refs.length).toBe(b.evidence_refs.length);
    expect(a.findings).toEqual(b.findings);
    expect(a.coverage_limitations).toEqual(b.coverage_limitations);
  });
});
