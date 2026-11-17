import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  StateStore,
  buildHtmlReport,
  buildReport,
  emitChecklistEvent,
  previewCommand,
  readChecklistEvents,
  renderChecklist,
  startDashboard,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-cmd-preview-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const workflow = { id: "release-confidence", name: "Release Confidence", version: "1.0.0", phases: [] } as any;

function minimalState(overrides: any = {}): any {
  return {
    run_id: "run-cp",
    workflow_id: "release-confidence",
    workflow_version: "1.0.0",
    target: { raw: ".", kind: "directory", resolved: "fixtures/target", source: null },
    intent: "test",
    status: "running",
    current_phase: "execution",
    phases: [],
    risks: [],
    checks: [],
    findings: [],
    invalid_findings: [],
    blockers: [],
    contract_failures: {},
    contract_failure_streaks: {},
    degraded_personas: [],
    confidence: { score: 0, band: "none", coverage: 0, rationale: "", limitations: [], penalties: {}, domain_scores: {}, breakdown: {}, gate: { status: "warn", reasons: [] } },
    kill_switch: { triggered: false, reason: "", manual: false, triggered_at: null },
    inventory: {},
    personas: [],
    options: {},
    evidence_dir: ".lemma/evidence/run-cp",
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    halted_reason: "",
    error: "",
    seed: null,
    clock_mode: "real",
    mode: "test",
    run_size: "medium",
    perspectives_count: 4,
    coverage_notes: [],
    ...overrides,
  };
}

describe("LEM-190 command preview and live checklist", () => {
  it("previewCommand returns deterministic typed preview (steps, expected evidence, expected duration) given same command+args+run", () => {
    const run = { run_id: "r1", status: "running", mode: "test", run_size: "medium", intent: "x", target: { resolved: "app" } };
    const a = previewCommand({ command: "run", args: ["app", "--fast"], run });
    const b = previewCommand({ command: "run", args: ["app", "--fast"], run: JSON.parse(JSON.stringify(run)) });
    // deterministic key/content independent of generated_at
    expect(a.command).toBe("run");
    expect(a.args).toEqual(["app", "--fast"]);
    expect(a.deterministic_key).toBe(b.deterministic_key);
    expect(a.steps).toEqual(b.steps);
    expect(a.expected_evidence).toEqual(b.expected_evidence);
    expect(a.expected_duration_ms).toBe(b.expected_duration_ms);
    expect(a.summary.startsWith("Lemma will:")).toBe(true);
    expect(a.checklist.every((c) => c.state === "planned")).toBe(true);
    expect(a.steps.length).toBeGreaterThan(0);
    expect(a.expected_evidence.length).toBeGreaterThan(0);
    expect(typeof a.expected_duration_ms).toBe("number");
  });

  it("streams live checklist states (planned/observed/blocked/skipped) via StateStore events", async () => {
    await withTempDir(async (root) => {
      const store = new StateStore(root);
      await store.ensure();
      const preview = previewCommand({ command: "run", args: [], run: { run_id: "r2" } });
      await emitChecklistEvent(store, { command: "run", run_id: "r2", item_id: preview.steps[0]!.id, title: preview.steps[0]!.title, state: "planned" });
      await emitChecklistEvent(store, { command: "run", run_id: "r2", item_id: preview.steps[0]!.id, title: preview.steps[0]!.title, state: "observed" });
      await emitChecklistEvent(store, { command: "run", run_id: "r2", item_id: preview.steps[1]!.id, title: preview.steps[1]!.title, state: "blocked", note: "capability missing" });
      await emitChecklistEvent(store, { command: "run", run_id: "r2", item_id: preview.steps[2]!.id, title: preview.steps[2]!.title, state: "skipped" });

      const events = await readChecklistEvents(store);
      expect(events.map((e) => e.state)).toEqual(["planned", "observed", "blocked", "skipped"]);
      const rendered = renderChecklist(events, preview);
      expect(rendered.find((x) => x.id === preview.steps[0]!.id)?.state).toBe("observed");
      expect(rendered.find((x) => x.id === preview.steps[1]!.id)?.state).toBe("blocked");
      expect(rendered.find((x) => x.id === preview.steps[2]!.id)?.state).toBe("skipped");
    });
  });

  it("surfaces preview and live checklist in dashboard and HTML report", async () => {
    await withTempDir(async (root) => {
      const store = new StateStore(root);
      await store.ensure();
      const preview = previewCommand({ command: "run", args: ["."], run: { run_id: "run-cp", status: "running" } });
      const state = minimalState({ options: { command_preview: preview }, command: "run", args: ["."] });
      await store.saveProgress(state);
      await emitChecklistEvent(store, { command: "run", run_id: "run-cp", item_id: preview.steps[0]!.id, title: preview.steps[0]!.title, state: "observed" });
      await emitChecklistEvent(store, { command: "run", run_id: "run-cp", item_id: preview.steps[1]!.id, title: preview.steps[1]!.title, state: "planned" });

      // dashboard rendering
      const dash = await startDashboard({ stateStore: store, host: "127.0.0.1" });
      try {
        expect(dash.disabled).not.toBe(true);
        const base = dash.url.split("?")[0]!;
        const res = await fetch(`${base}api/live?token=${encodeURIComponent(dash.token)}`);
        const json: any = await res.json();
        expect(json.ok).toBe(true);
        expect(json.live?.command_preview?.summary).toContain("Lemma will:");
        expect(Array.isArray(json.live?.live_checklist)).toBe(true);
        const states = (json.live.live_checklist as any[]).map((i) => i.state);
        expect(states).toContain("observed");
        expect(states).toContain("planned");
      } finally {
        await dash.close();
      }

      // HTML report surfacing
      const checklist = renderChecklist(await readChecklistEvents(store), preview);
      const report = buildReport({ ...state, options: { ...state.options, live_checklist: checklist } }, workflow, {}) as any;
      expect(report.command_preview?.summary).toContain("Lemma will:");
      expect(Array.isArray(report.live_checklist)).toBe(true);
      const html = await buildHtmlReport(report);
      expect(html).toContain("Command Preview (Lemma will:)");
      expect(html).toContain("Live Checklist");
      expect(html).toContain("observed");
    });
  });
});
