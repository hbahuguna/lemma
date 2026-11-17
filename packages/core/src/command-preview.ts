import { createHash } from "node:crypto";

import { now } from "./determinism.js";
import type { StateStore } from "./state-store.js";

export type ChecklistItemState = "planned" | "observed" | "blocked" | "skipped";

export interface CommandPreviewStep {
  id: string;
  title: string;
  description: string;
  expected_evidence: string[];
  expected_duration_ms: number;
  state: "planned";
}

export interface CommandPreview {
  schema_version: "lemma.command_preview/v1";
  command: string;
  args: string[];
  run_id: string | null;
  generated_at: string;
  deterministic_key: string;
  summary: string;
  steps: CommandPreviewStep[];
  expected_evidence: string[];
  expected_duration_ms: number;
  checklist: Array<{ id: string; title: string; state: ChecklistItemState; note?: string }>;
}

export interface ChecklistEvent {
  event: "checklist_item";
  command: string;
  run_id: string | null;
  item_id: string;
  title: string;
  state: ChecklistItemState;
  note?: string;
  timestamp?: string;
  [key: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stableKey(command: string, args: string[], run: unknown): string {
  const runObj = isRecord(run) ? run : {};
  const fingerprint = {
    command,
    args,
    run_id: typeof runObj.run_id === "string" ? runObj.run_id : null,
    status: typeof runObj.status === "string" ? runObj.status : null,
    mode: typeof (runObj as any).mode === "string" ? (runObj as any).mode : null,
    run_size: typeof (runObj as any).run_size === "string" ? (runObj as any).run_size : null,
    intent: typeof runObj.intent === "string" ? runObj.intent : null,
  };
  return createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 16);
}

function normalizeArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  return args.map((a) => String(a));
}

function baseSteps(command: string, args: string[], run: any): Array<Omit<CommandPreviewStep, "id" | "state">> {
  const target = run?.target?.resolved || run?.target?.raw || args[0] || "(target)";
  const mode = run?.mode || "test";
  const size = run?.run_size || "medium";
  const common = [
    {
      title: "Plan command execution",
      description: `Lemma will preview '${command}' with deterministic steps before execution.`,
      expected_evidence: ["command preview (JSON)"],
      expected_duration_ms: 10,
    },
    {
      title: "Prepare run context",
      description: `Lemma will resolve target '${String(target)}' and apply mode='${String(mode)}', size='${String(size)}'.`,
      expected_evidence: ["run context", "settings/state snapshot"],
      expected_duration_ms: 50,
    },
  ];

  const cmd = command.toLowerCase();
  if (cmd === "run" || cmd === "test") {
    return [
      ...common,
      { title: "Execute planned checks", description: "Lemma will execute planned checks for the selected scope and record outcomes.", expected_evidence: ["check outcomes", "evidence artifacts"], expected_duration_ms: 5000 },
      { title: "Collect evidence and score", description: "Lemma will collect evidence, compute confidence, and produce a report.", expected_evidence: ["evidence manifest", "final report"], expected_duration_ms: 1000 },
    ];
  }
  if (cmd === "review") {
    return [
      ...common,
      { title: "Run independent review", description: "Lemma will execute independent review and record contested/unsupported findings with evidence links.", expected_evidence: ["review report", "review notes"], expected_duration_ms: 2000 },
      { title: "Attach review to run", description: "Lemma will attach review artifacts to the run/report without overriding the decision.", expected_evidence: ["updated report/review linkage"], expected_duration_ms: 200 },
    ];
  }
  if (cmd === "plan") {
    return [
      ...common,
      { title: "Generate planned tests", description: "Lemma will produce planned tests/checks only (no execution findings).", expected_evidence: ["planned checks", "planning rationale"], expected_duration_ms: 1500 },
    ];
  }
  if (cmd === "focused") {
    return [
      ...common,
      { title: "Execute bounded subset", description: "Lemma will run only the explicitly scoped subset and record in-scope evidence.", expected_evidence: ["subset outcomes", "scope/coverage notes"], expected_duration_ms: 2500 },
    ];
  }
  if (cmd === "learn") {
    return [
      ...common,
      { title: "Run exploratory learning", description: "Lemma will explore without producing final findings and record observations.", expected_evidence: ["exploratory observations"], expected_duration_ms: 2000 },
    ];
  }
  if (cmd === "browser") {
    return [
      ...common,
      { title: "Run browser inspection", description: "Lemma will perform scoped browser inspection and capture evidence where available.", expected_evidence: ["browser observations", "screenshots/evidence refs"], expected_duration_ms: 4000 },
    ];
  }
  if (cmd === "forever" || cmd === "auto") {
    return [
      ...common,
      { title: "Run bounded iterative workflow", description: `Lemma will execute bounded '${command}' cycles with checkpoints and mission reporting.`, expected_evidence: ["cycle checkpoints", "mission report"], expected_duration_ms: 8000 },
    ];
  }
  return [
    ...common,
    { title: `Execute '${command}'`, description: `Lemma will execute the '${command}' command with provided arguments.`, expected_evidence: ["command output/artifacts"], expected_duration_ms: 1000 },
  ];
}

export function previewCommand(input: { command: string; args?: string[]; run?: unknown }): CommandPreview {
  const command = String(input.command || "").trim() || "unknown";
  const args = normalizeArgs(input.args ?? []);
  const run = input.run ?? null;
  const runObj = isRecord(run) ? run : {};
  const key = stableKey(command, args, run);
  const stepsBase = baseSteps(command, args, runObj);
  const steps: CommandPreviewStep[] = stepsBase.map((s, i) => ({
    id: `step-${key}-${i + 1}`,
    state: "planned",
    title: s.title,
    description: s.description,
    expected_evidence: [...s.expected_evidence],
    expected_duration_ms: s.expected_duration_ms,
  }));
  const expectedEvidence = Array.from(new Set(steps.flatMap((s) => s.expected_evidence)));
  const expectedDuration = steps.reduce((sum, s) => sum + s.expected_duration_ms, 0);
  const checklist = steps.map((s) => ({ id: s.id, title: s.title, state: "planned" as ChecklistItemState }));

  return {
    schema_version: "lemma.command_preview/v1",
    command,
    args,
    run_id: typeof runObj.run_id === "string" ? runObj.run_id : null,
    generated_at: now(),
    deterministic_key: key,
    summary: `Lemma will: ${steps.map((s) => s.title).join(" → ")}`,
    steps,
    expected_evidence: expectedEvidence,
    expected_duration_ms: expectedDuration,
    checklist,
  };
}

export async function emitChecklistEvent(
  store: Pick<StateStore, "appendEvent">,
  event: Omit<ChecklistEvent, "event" | "timestamp"> & { timestamp?: string },
): Promise<ChecklistEvent> {
  const record: ChecklistEvent = {
    event: "checklist_item",
    timestamp: (event.timestamp ?? now()) as string,
    command: String(event.command),
    run_id: event.run_id == null ? null : String(event.run_id),
    item_id: String(event.item_id),
    title: String(event.title),
    state: event.state as ChecklistItemState,
    ...(event.note ? { note: String(event.note) } : {}),
  };
  await store.appendEvent(record as any);
  return record;
}

export async function readChecklistEvents(
  store: Pick<StateStore, "lemmaDir"> | { lemmaDir?: string; eventsPath?: string } | any,
): Promise<ChecklistEvent[]> {
  try {
    const fs = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const eventsPath = (store && typeof store.eventsPath === "string")
      ? store.eventsPath
      : (store && typeof store.lemmaDir === "string")
        ? pathMod.join(store.lemmaDir, "events.jsonl")
        : null;
    if (!eventsPath) return [];
    const raw = await fs.readFile(eventsPath, "utf8");
    const out: ChecklistEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && obj.event === "checklist_item" && typeof obj.item_id === "string" && typeof obj.state === "string") {
          const st = obj.state as ChecklistItemState;
          if (st === "planned" || st === "observed" || st === "blocked" || st === "skipped") {
            out.push({
              event: "checklist_item",
              command: String(obj.command ?? ""),
              run_id: obj.run_id == null ? null : String(obj.run_id),
              item_id: String(obj.item_id),
              title: String(obj.title ?? obj.item_id),
              state: st,
              ...(obj.note ? { note: String(obj.note) } : {}),
              ...(obj.timestamp ? { timestamp: String(obj.timestamp) } : {}),
            });
          }
        }
      } catch { /* ignore */ }
    }
    return out;
  } catch {
    return [];
  }
}

export function renderChecklist(events: ChecklistEvent[], preview?: CommandPreview | null): Array<{ id: string; title: string; state: ChecklistItemState; note?: string }> {
  const base = new Map<string, { id: string; title: string; state: ChecklistItemState; note?: string }>();
  if (preview?.checklist) {
    for (const item of preview.checklist) base.set(item.id, { ...item });
  }
  for (const ev of events) {
    const prev = base.get(ev.item_id);
    base.set(ev.item_id, { id: ev.item_id, title: ev.title || prev?.title || ev.item_id, state: ev.state, ...(ev.note ? { note: ev.note } : (prev?.note ? { note: prev.note } : {})) });
  }
  return Array.from(base.values());
}
