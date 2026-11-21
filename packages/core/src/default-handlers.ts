import path from "node:path";
import { statSync } from "node:fs";

import { EvidenceStore } from "./evidence.js";
import { planChecks } from "./checks.js";
import { normalizeTarget, CheckStatus, type Check, type Finding, type RunStateDomain } from "./models.js";
import { checkOwnership, loadPersonas, type Persona } from "./personas.js";
import { analyzeRisk } from "./risk.js";
import { buildTestPlan } from "./test-plan.js";
import { scoreConfidence } from "./scoring.js";
import { SourceInspector, StaticCheckRunner, getMaxInventoryFiles, type InventoryData } from "./static.js";
import type { PhaseHandlerContext, PhaseHandlers } from "./orchestrator.js";

function toInventoryRecord(inv: InventoryData): Record<string, unknown> {
  return {
    ...inv,
    available: inv.available,
    source_files: inv.source_files,
    test_files: inv.test_files,
    markup_files: inv.markup_files,
    ci_files: inv.ci_files,
    manifests: inv.manifests,
    lockfiles: inv.lockfiles,
    env_files: inv.env_files,
    env_files_tracked: inv.env_files_tracked,
    tracked_available: inv.tracked_available,
    has_markup: (inv.markup_files?.length ?? 0) > 0,
    has_manifest: (inv.manifests?.length ?? 0) > 0,
  } as Record<string, unknown>;
}

async function discoverInventory(targetRoot: string): Promise<InventoryData> {
  try {
    const st = statSync(targetRoot);
    if (!st.isDirectory()) {
      return {
        available: false, root: targetRoot, files: [], source_files: [], markup_files: [], manifests: [], test_files: [], ci_files: [], lockfiles: [], env_files: [], languages: {}, total_files: 0, total_bytes: 0, truncated: false, skipped_dirs: [], test_frameworks: [], tracked_available: false, tracked_file_count: 0, env_files_tracked: [], env_files_ignored: [], excluded_patterns: [], excluded_paths: [], excluded_file_count: 0,
      } as InventoryData;
    }
  } catch {
    return {
      available: false, root: targetRoot, files: [], source_files: [], markup_files: [], manifests: [], test_files: [], ci_files: [], lockfiles: [], env_files: [], languages: {}, total_files: 0, total_bytes: 0, truncated: false, skipped_dirs: [], test_frameworks: [], tracked_available: false, tracked_file_count: 0, env_files_tracked: [], env_files_ignored: [], excluded_patterns: [], excluded_paths: [], excluded_file_count: 0,
    } as InventoryData;
  }
  try {
    return new SourceInspector(targetRoot, { maxFiles: getMaxInventoryFiles() }).discover();
  } catch {
    return {
      available: false, root: targetRoot, files: [], source_files: [], markup_files: [], manifests: [], test_files: [], ci_files: [], lockfiles: [], env_files: [], languages: {}, total_files: 0, total_bytes: 0, truncated: false, skipped_dirs: [], test_frameworks: [], tracked_available: false, tracked_file_count: 0, env_files_tracked: [], env_files_ignored: [], excluded_patterns: [], excluded_paths: [], excluded_file_count: 0,
    } as InventoryData;
  }
}

function inferTargetRoot(state: RunStateDomain): string {
  const t = state.target as any;
  if (t && typeof t.resolved === "string" && t.resolved) {
    // if it's a URL, fall back to cwd
    if (t.kind === "url" || /^https?:\/\//i.test(t.resolved)) return process.cwd();
    return path.resolve(t.resolved);
  }
  if (t && typeof t.raw === "string" && t.raw && !/^https?:\/\//i.test(t.raw)) return path.resolve(t.raw);
  return process.cwd();
}

export interface DefaultPhaseHandlersOptions {
  personasDir?: string;
  noBrowser?: boolean;
  maxChecks?: number;
}

export function createDefaultPhaseHandlers(options: DefaultPhaseHandlersOptions = {}): PhaseHandlers {
  let inventory: InventoryData | null = null;
  let personas: Persona[] = [];
  let ownership: Record<string, string[]> = {};
  let evidence: EvidenceStore | null = null;

  return {
    async risk_analysis(ctx: PhaseHandlerContext) {
      const targetRoot = inferTargetRoot(ctx.state);
      inventory = await discoverInventory(targetRoot);
      ctx.state.target = normalizeTarget(ctx.state.target as any);
      const noBrowser = options.noBrowser ?? (ctx.options as any).noBrowser ?? (ctx.state.target as any)?.kind !== "url";
      try {
        const risks = analyzeRisk(ctx.state.target as any, ctx.options.intent ?? ctx.state.intent ?? "", toInventoryRecord(inventory), !noBrowser);
        (ctx.state as any).risks = risks;
        ctx.phase.summary = `Identified ${Array.isArray(risks) ? risks.length : 0} risk(s)`;
        ctx.phase.details = { risk_count: Array.isArray(risks) ? risks.length : 0 };
      } catch (e) {
        (ctx.state as any).risks = (ctx.state as any).risks ?? [];
        ctx.phase.summary = `Risk analysis completed with limitations: ${e instanceof Error ? e.message : String(e)}`;
      }
    },

    async test_planning(ctx: PhaseHandlerContext) {
      const personasDir = options.personasDir ?? (ctx.options as any).personasDir;
      try {
        if (personasDir) {
          personas = await loadPersonas(personasDir, { requireMinimum: 0 } as any);
        } else {
          personas = [];
        }
      } catch {
        personas = [];
      }
      try {
        ownership = personas.length ? checkOwnership(personas as any) : {};
      } catch {
        ownership = {};
      }

      if (!inventory) inventory = await discoverInventory(inferTargetRoot(ctx.state));
      const selectedPersonas = personas.map((p) => p.id);
      let planned: Check[] = [];
      try {
        planned = planChecks({
          target: ctx.state.target as any,
          inventory: toInventoryRecord(inventory),
          selectedPersonas,
          ownership,
          maxChecks: ctx.budget.maxChecks,
          noBrowser: options.noBrowser ?? (ctx.options as any).noBrowser ?? (ctx.state.target as any)?.kind !== "url",
          intent: ctx.options.intent ?? ctx.state.intent ?? "",
        } as any);
      } catch (e) {
        planned = [];
        ctx.phase.summary = `Test planning completed with limitations: ${e instanceof Error ? e.message : String(e)}`;
      }
      ctx.state.checks = planned.map((c) => ({ ...c, status: c.status || "planned" })) as any;
      const testPlan = buildTestPlan({
        intent: ctx.options.intent ?? ctx.state.intent ?? "",
        target: ctx.state.target as any,
        inventory: inventory as unknown as Record<string, unknown>,
        checks: ctx.state.checks,
        risks: (ctx.state as any).risks ?? [],
        command: typeof (ctx.options as any).command === "string"
          ? (ctx.options as any).command
          : typeof (ctx.options.options as any)?.command === "string"
            ? (ctx.options.options as any).command
            : undefined,
      });
      (ctx.state as any).test_plan = testPlan;
      ctx.phase.details = {
        planned_checks: ctx.state.checks.length,
        personas_loaded: personas.length,
        test_plan_profile: testPlan.profile,
        test_plan_scenarios: testPlan.scenarios.length,
      };
      if (!ctx.phase.summary) ctx.phase.summary = `Planned ${ctx.state.checks.length} check(s) and ${testPlan.scenarios.length} test scenario(s) from ${personas.length} persona(s)`;
    },

    async execution(ctx: PhaseHandlerContext) {
      const root = inferTargetRoot(ctx.state);
      if (!inventory) inventory = await discoverInventory(root);
      evidence = new EvidenceStore(ctx.store.root, ctx.state.run_id);
      await evidence.init();
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const findings: Finding[] = Array.isArray((ctx.state as any).findings) ? (ctx.state as any).findings : [];
      const target = ctx.state.target as any;
      const noBrowser = options.noBrowser ?? (ctx.options as any).noBrowser ?? target?.kind !== "url";

      // Execute browser checks as a batch when possible
      const browserIndexes: number[] = [];
      for (let i = 0; i < ctx.state.checks.length; i++) {
        const c = ctx.state.checks[i] as any;
        if (String(c.kind) === "browser" || String(c.id).startsWith("browser.")) browserIndexes.push(i);
      }
      if (browserIndexes.length > 0) {
        if (!noBrowser && target?.kind === "url" && typeof target.resolved === "string") {
          try {
            const mod = await import("@lemma/browser");
            const browserChecks = browserIndexes.map((i) => ctx.state.checks[i] as any);
            const byId = new Map(browserChecks.map((c: any) => [c.id, c]));
            await mod.runBrowserChecks({
              url: target.resolved,
              checks: browserChecks as any,
              evidence,
              options: { crawl: true, maxPages: 10, headless: (ctx.options as any)?.headless ?? true, ...(ctx.options as any)?.browserOptions },
              onOutcome: async (check: any, outcome: any) => {
                const c = byId.get(check.id);
                if (!c) return;
                c.status = outcome.status ?? CheckStatus.ERROR;
                c.actual = outcome.actual ?? c.actual;
                if (Array.isArray(outcome.findings)) {
                  c.finding_ids = outcome.findings.map((f: any) => f?.id).filter(Boolean);
                  for (const f of outcome.findings) findings.push(f);
                }
              },
            } as any);
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            for (const i of browserIndexes) {
              const c = ctx.state.checks[i] as any;
              c.status = CheckStatus.BLOCKED;
              c.actual = `Browser checks could not be executed: ${reason}`;
            }
          }
        } else {
          for (const i of browserIndexes) {
            const c = ctx.state.checks[i] as any;
            c.status = CheckStatus.BLOCKED;
            c.actual = noBrowser ? "Browser checks disabled (--no-browser)." : "Browser checks require a URL target.";
          }
        }
      }

      for (let i = 0; i < ctx.state.checks.length; i++) {
        const check = ctx.state.checks[i] as any;
        if (await ctx.isKillRequested()) {
          await ctx.halt(String(await ctx.isKillRequested() || "Kill requested"), true);
          break;
        }
        // browser checks handled above
        if (String(check.kind) === "browser" || String(check.id).startsWith("browser.")) {
          ctx.state.checks[i] = check;
          continue;
        }
        try {
          if (String(check.id).startsWith("static.")) {
            const outcome = await runner.run(check as any);
            check.status = outcome.status ?? CheckStatus.ERROR;
            check.actual = outcome.actual;
            check.finding_ids = Array.isArray((outcome as any).findings) ? (outcome as any).findings.map((f: any) => f?.id).filter(Boolean) : [];
            if (Array.isArray((outcome as any).findings)) {
              for (const f of (outcome as any).findings) findings.push(f);
            }
          } else {
            check.status = CheckStatus.SKIPPED;
            check.actual = "No execution handler available for this check type in default handlers.";
          }
        } catch (e) {
          check.status = CheckStatus.ERROR;
          check.actual = e instanceof Error ? e.message : String(e);
        }
        ctx.state.checks[i] = check;
      }

      (ctx.state as any).findings = findings;
      ctx.phase.details = {
        executed: ctx.state.checks.filter((c: any) => c.status === "passed" || c.status === "failed").length,
        blocked: ctx.state.checks.filter((c: any) => c.status === "blocked").length,
        skipped: ctx.state.checks.filter((c: any) => c.status === "skipped").length,
        errored: ctx.state.checks.filter((c: any) => c.status === "error" || c.status === "errored").length,
      };
      ctx.phase.summary = `Executed checks (default handlers): ${ctx.state.checks.length} total`;
      await ctx.save();
    },

    async evidence_collection(ctx: PhaseHandlerContext) {
      try {
        if (!evidence) {
          evidence = new EvidenceStore(ctx.store.root, ctx.state.run_id);
          await evidence.init();
        }
        const manifest = await evidence.finalize({ run_id: ctx.state.run_id });
        ctx.phase.details = { evidence_manifest: manifest?.path ?? null, artifacts: Array.isArray(manifest?.artifacts) ? manifest.artifacts.length : 0 };
        ctx.phase.summary = "Evidence manifest finalized";
      } catch (e) {
        ctx.phase.summary = `Evidence collection completed with limitations: ${e instanceof Error ? e.message : String(e)}`;
      }
    },

    async confidence_scoring(ctx: PhaseHandlerContext) {
      try {
        const checks = ctx.state.checks as any[];
        const findings = ((ctx.state as any).findings ?? []) as any[];
        const halted = ctx.state.status === "halted" || ctx.state.kill_switch?.triggered === true;
        const confidence = scoreConfidence(checks as any, findings as any, {
          halted,
          ...(ctx.state.kill_switch?.reason ? { killReason: ctx.state.kill_switch.reason } : {}),
        });
        (ctx.state as any).confidence = confidence;
        (ctx.state as any).score = (confidence as any)?.score;
        ctx.phase.details = { score: (confidence as any)?.score, band: (confidence as any)?.band };
        ctx.phase.summary = `Scored confidence: ${(confidence as any)?.score ?? 0}`;
      } catch (e) {
        ctx.phase.summary = `Confidence scoring failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}
