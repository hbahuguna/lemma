import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  Orchestrator,
  RELEASE_CONFIDENCE,
  RunStatus,
  StateStore,
  newId,
  normalizeTarget,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-seeded-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function seededOpts(seed = 1234, frozenClock = "2026-01-02T03:04:05Z") {
  return { seed, clockMode: "frozen" as const, frozenClock };
}

describe("LEM-022 seeded resume and id-sequence continuity", () => {
  it("persists determinism and id sequence in progress/options", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const orch = new Orchestrator({
        store,
        handlers: {
          test_planning: (ctx) => {
            ctx.state.checks = [
              {
                id: newId("check"),
                title: "A",
                domain: "functional",
                persona: "p",
                kind: "static",
                intent: "i",
                expected: "e",
                base_weight: 1,
                weight: 1,
                status: CheckStatus.PLANNED,
                actual: "",
                evidence: [],
                finding_ids: [],
                skip_reason: "",
                metadata: {},
                started_at: null,
                completed_at: null,
              },
            ];
          },
          execution: (ctx) => {
            for (const c of ctx.state.checks) c.status = CheckStatus.PASSED;
          },
        },
      });
      const state = await orch.run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
        workflow: RELEASE_CONFIDENCE,
        ...seededOpts(),
      });
      expect(state.seed).toBe(1234);
      expect(state.clock_mode).toBe("frozen");
      expect(state.options.frozen_clock).toBe("2026-01-02T03:04:05Z");
      expect(typeof state.options.id_sequence).toBe("number");
      expect((state.options.id_sequence as number) > 0).toBe(true);
      expect(state.options.entropy_counter).toBe(state.options.id_sequence);
      const saved = JSON.parse(await readFile(store.progressPath, "utf8")) as Record<string, unknown>;
      expect(saved.seed).toBe(1234);
      expect((saved.options as Record<string, unknown>).id_sequence).toBe(state.options.id_sequence);
    });
  });

  it("restores saved determinism options and continues id sequence on resume", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      let crashInjected = false;
      const makeOrch = () =>
        new Orchestrator({
          store,
          handlers: {
            risk_analysis: () => {},
            test_planning: (ctx) => {
              if (ctx.state.checks.length === 0) {
                ctx.state.checks = [
                  { id: newId("check"), title: "A", domain: "functional", persona: "p", kind: "static", intent: "i", expected: "e", base_weight: 1, weight: 1, status: CheckStatus.PLANNED, actual: "", evidence: [], finding_ids: [], skip_reason: "", metadata: {}, started_at: null, completed_at: null },
                  { id: newId("check"), title: "B", domain: "functional", persona: "p", kind: "static", intent: "i", expected: "e", base_weight: 1, weight: 1, status: CheckStatus.PLANNED, actual: "", evidence: [], finding_ids: [], skip_reason: "", metadata: {}, started_at: null, completed_at: null },
                ];
              }
            },
            execution: (ctx) => {
              for (const c of ctx.state.checks) {
                if (c.status === CheckStatus.PASSED) continue;
                c.status = CheckStatus.PASSED;
                c.actual = "ok";
                if (!crashInjected) {
                  crashInjected = true;
                  throw new Error("simulated crash");
                }
              }
            },
            evidence_collection: () => {},
            confidence_scoring: (ctx) => {
              // generate deterministic ids after resume
              ctx.state.options.post_resume_id = newId("post");
            },
          },
        });

      await expect(
        makeOrch().run({
          target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
          workflow: RELEASE_CONFIDENCE,
          ...seededOpts(777),
        }),
      ).rejects.toThrow(/simulated crash/);

      const crashed = JSON.parse(await readFile(store.progressPath, "utf8")) as { status: string; options?: Record<string, unknown> };
      expect(crashed.status).toBe(RunStatus.FAILED);
      const crashedSeq = typeof crashed.options?.id_sequence === "number" ? crashed.options.id_sequence : 0;

      // Resume with different determinism options; saved state must win and sequence must continue.
      const resumed = await makeOrch().run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
        workflow: RELEASE_CONFIDENCE,
        resume: true,
        seed: 999,
        clockMode: "real",
      });
      expect(resumed.status).toBe(RunStatus.COMPLETED);
      expect(resumed.seed).toBe(777);
      expect(resumed.clock_mode).toBe("frozen");
      expect(resumed.options.frozen_clock).toBe("2026-01-02T03:04:05Z");
      expect((resumed.options.id_sequence as number) >= crashedSeq).toBe(true);
      expect(typeof resumed.options.post_resume_id).toBe("string");
      expect(String(resumed.options.post_resume_id)).toMatch(/^post-/);
    });
  });

  it("produces same seeded IDs as uninterrupted run and keeps completed-run ids stable on resume", async () => {
    await withTempDir(async (freshDir) => {
      await withTempDir(async (crashDir) => {
        const makeHandlers = (mode: "fresh" | "crash", flag: { crashed: boolean }) => ({
          risk_analysis: () => {},
          test_planning: (ctx: { state: { checks: unknown[] } }) => {
            if (ctx.state.checks.length === 0) {
              ctx.state.checks = [
                { id: newId("check"), title: "A", domain: "functional", persona: "p", kind: "static", intent: "i", expected: "e", base_weight: 1, weight: 1, status: CheckStatus.PLANNED, actual: "", evidence: [], finding_ids: [], skip_reason: "", metadata: {}, started_at: null, completed_at: null },
                { id: newId("check"), title: "B", domain: "functional", persona: "p", kind: "static", intent: "i", expected: "e", base_weight: 1, weight: 1, status: CheckStatus.PLANNED, actual: "", evidence: [], finding_ids: [], skip_reason: "", metadata: {}, started_at: null, completed_at: null },
              ];
            }
          },
          execution: (ctx: { state: { checks: Array<{ id: string; status: string; actual: string; finding_ids: string[] }> } }) => {
            for (const c of ctx.state.checks) {
              if (c.status === CheckStatus.PASSED) continue;
              c.status = CheckStatus.PASSED;
              c.actual = "ok";
              c.finding_ids = [newId("finding")];
              if (mode === "crash" && !flag.crashed && c.id.endsWith(ctx.state.checks[0]!.id.slice(-10))) {
                flag.crashed = true;
                throw new Error("simulated crash");
              }
            }
          },
          evidence_collection: () => {},
          confidence_scoring: () => {},
        });

        const fresh = await new Orchestrator({ store: new StateStore(freshDir), handlers: makeHandlers("fresh", { crashed: false }) }).run({
          target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
          workflow: RELEASE_CONFIDENCE,
          ...seededOpts(4242),
        });

        const crashStore = new StateStore(crashDir);
        const flag = { crashed: false };
        await expect(
          new Orchestrator({ store: crashStore, handlers: makeHandlers("crash", flag) }).run({
            target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
            workflow: RELEASE_CONFIDENCE,
            ...seededOpts(4242),
          }),
        ).rejects.toThrow(/simulated crash/);

        const resumed = await new Orchestrator({ store: crashStore, handlers: makeHandlers("fresh", { crashed: true }) }).run({
          target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
          workflow: RELEASE_CONFIDENCE,
          resume: true,
          ...seededOpts(4242),
        });

        expect(resumed.run_id).toBe(fresh.run_id);
        expect(resumed.checks.map((c) => c.id)).toEqual(fresh.checks.map((c) => c.id));
        expect(resumed.checks.flatMap((c) => c.finding_ids)).toEqual(fresh.checks.flatMap((c) => c.finding_ids));

        const before = JSON.stringify(resumed.checks.map((c) => [c.id, c.finding_ids]));
        const rerun = await new Orchestrator({ store: crashStore }).run({
          target: normalizeTarget({ raw: ".", kind: "directory", resolved: "/repo" }),
          workflow: RELEASE_CONFIDENCE,
          resume: true,
          ...seededOpts(4242),
        });
        expect(rerun.status).toBe(RunStatus.COMPLETED);
        expect(JSON.stringify(rerun.checks.map((c) => [c.id, c.finding_ids]))).toBe(before);
      });
    });
  });
});
