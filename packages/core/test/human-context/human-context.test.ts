import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CorruptStateError,
  StateError,
  StateStore,
  readHumanContextState,
  runHumanContext,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-human-ctx-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const catalog = {
  schema_version: "lemma.human.decision_context/v1",
  catalog_version: "1",
  questions: [
    {
      id: "HUM-RELEASE-OWNER",
      prompt: "Who approved release readiness?",
      materiality: { affects: ["decision", "release_readiness"], reason: "Release owner sign-off is required for readiness." },
    },
    {
      id: "HUM-RISK-NOTE",
      prompt: "Any residual risk notes?",
      materiality: { affects: ["risk"], reason: "Residual risk context can change risk interpretation." },
      allows_freeform: true,
    },
    {
      id: "HUM-OPTIONAL",
      prompt: "Optional note",
      materiality: { affects: ["confidence"], reason: "Informational only", material: false },
    },
  ],
};

describe("LEM-168 human decision-context workflow", () => {
  it("validates question catalog integrity (versioned HUM-* ids and documented materiality)", async () => {
    await withTempDir(async (root) => {
      await expect(runHumanContext({
        runId: "run-1",
        root,
        questions: { schema_version: "lemma.human.decision_context/v1", questions: [{ id: "BAD", prompt: "x", materiality: { affects: ["risk"], reason: "r" } }] } as any,
      })).rejects.toBeInstanceOf(StateError);

      await expect(runHumanContext({
        runId: "run-1",
        root,
        questions: { schema_version: "lemma.human.decision_context/v1", questions: [{ id: "HUM-NO-MAT", prompt: "x", materiality: { affects: [], reason: "" } as any }] } as any,
      })).rejects.toBeInstanceOf(StateError);
    });
  });

  it("applies materiality gating: unanswered material question escalates to hold with explicit blocker; non-material does not", async () => {
    await withTempDir(async (root) => {
      const result = await runHumanContext({
        runId: "run-2",
        root,
        questions: catalog as any,
        answers: { "HUM-RISK-NOTE": "all good" }, // HUM-RELEASE-OWNER still unanswered (material), HUM-OPTIONAL non-material
      });
      expect(result.decision).toBe("hold");
      expect(result.unanswered_material_question_ids).toContain("HUM-RELEASE-OWNER");
      expect(result.unanswered_material_question_ids).not.toContain("HUM-OPTIONAL");
      expect(result.blockers.some((b) => b.question_id === "HUM-RELEASE-OWNER" && b.unresolved)).toBe(true);
      expect(result.blockers.some((b) => b.question_id === "HUM-OPTIONAL")).toBe(false);
    });
  });

  it("persists answers atomically to .lemma/human/decision-context.json and is resumable", async () => {
    await withTempDir(async (root) => {
      const first = await runHumanContext({
        runId: "run-3",
        root,
        questions: catalog as any,
        answers: { "HUM-RELEASE-OWNER": "alice" },
      });
      expect(first.context_path).toContain(path.join(".lemma", "human", "decision-context.json"));
      const onDisk = JSON.parse(await fs.readFile(path.join(root, ".lemma", "human", "decision-context.json"), "utf8"));
      expect(onDisk.schema_version).toBe("lemma.human.decision_context/v1");
      expect(onDisk.answers["HUM-RELEASE-OWNER"]).toBeTruthy();

      const resumed = await runHumanContext({
        runId: "run-3",
        root,
        questions: catalog as any,
        answers: { "HUM-RISK-NOTE": "none" },
      });
      expect(resumed.resumed).toBe(true);
      expect(resumed.state.answers["HUM-RELEASE-OWNER"]).toBeTruthy();
      expect(resumed.state.answers["HUM-RISK-NOTE"]).toBeTruthy();
      expect(resumed.decision).toBe("unchanged");
      expect(resumed.blockers).toHaveLength(0);
    });
  });

  it("raises typed corrupt-read error for corrupt context file", async () => {
    await withTempDir(async (root) => {
      const p = path.join(root, ".lemma", "human");
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(path.join(p, "decision-context.json"), "{ not valid json", "utf8");
      await expect(readHumanContextState(path.join(p, "decision-context.json"))).rejects.toSatisfy((e: any) => e instanceof CorruptStateError || e instanceof StateError);
    });
  });

  it("redacts before persistence; free-form only when explicitly requested and still redacted", async () => {
    await withTempDir(async (root) => {
      const result = await runHumanContext({
        runId: "run-4",
        root,
        questions: catalog as any,
        answers: {
          "HUM-RISK-NOTE": "token=sk-SECRET12345678901234567890", // free-form allowed but must be redacted
          "HUM-RELEASE-OWNER": "Bearer abc.def.ghi", // not free-form, still redacted before persistence
        },
      });
      const raw = await fs.readFile(path.join(root, ".lemma", "human", "decision-context.json"), "utf8");
      expect(raw).not.toContain("SECRET12345678901234567890");
      expect(raw).not.toContain("abc.def.ghi");
      expect(result.state.answers["HUM-RISK-NOTE"].freeform).toBe(true);
      expect(result.state.answers["HUM-RISK-NOTE"].redacted).toBe(true);
    });
  });

  it("escalates run decision to hold with explicit blocker when stateStore/run provided", async () => {
    await withTempDir(async (root) => {
      const store = new StateStore(root);
      await store.saveProgress({ run_id: "run-5", decision: "ship", blockers: [] } as any);
      const result = await runHumanContext({
        runId: "run-5",
        root,
        stateStore: store,
        questions: catalog as any,
        answers: {},
      });
      expect(result.decision).toBe("hold");
      const progress = await store.loadProgress<any>();
      expect(progress.decision).toBe("hold");
      expect(Array.isArray(progress.blockers)).toBe(true);
      expect(progress.blockers.some((b: any) => b.question_id === "HUM-RELEASE-OWNER")).toBe(true);
    });
  });
});
