import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SteeredPlanStore } from "../../src/steered-plan.js";
import { ProUnavailableError, configureBots, runExploratoryBots } from "../../src/index.js";

const dirs: string[] = [];
async function mk(prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const licensed = { verification: true };

describe("LEM-199 exploratory bot configuration", () => {
  it("license gate: unlicensed configure/run returns ProUnavailableError", async () => {
    const root = await mk("lemma-bots-lic-");
    await expect(configureBots({ root, license: null, count: 1, depth: 1, scope: {} })).rejects.toBeInstanceOf(ProUnavailableError);
    await expect(runExploratoryBots({ root, license: null })).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("configureBots persists in steered plan and caps count/depth per tier", async () => {
    const root = await mk("lemma-bots-cap-");
    const res = await configureBots({ root, license: licensed, count: 10, depth: 9, scope: { area: "checkout" }, tier: "starter", seed: "s1" });
    expect(res.bots.tier).toBe("starter");
    expect(res.bots.tier_limits.count).toBe(2);
    expect(res.bots.tier_limits.depth).toBe(2);
    expect(res.bots.capped.count).toBe(2);
    expect(res.bots.capped.depth).toBe(2);
    expect(res.bots.caps_applied.count).toBe(true);
    expect(res.bots.caps_applied.depth).toBe(true);
    expect(res.bots.assignments).toHaveLength(2);

    const plan = await new SteeredPlanStore({ root }).load();
    const bots: any = plan.bots;
    expect(bots.capped.count).toBe(2);
    expect(bots.requested.scope).toEqual({ area: "checkout" });
  });

  it("is deterministic per seed: same plan + seed produces same bot assignments", async () => {
    const rootA = await mk("lemma-bots-det-a-");
    const rootB = await mk("lemma-bots-det-b-");
    const a = await configureBots({ root: rootA, license: licensed, count: 3, depth: 2, scope: { p: "/x" }, tier: "pro", seed: "seed-42" });
    const b = await configureBots({ root: rootB, license: licensed, count: 3, depth: 2, scope: { p: "/x" }, tier: "pro", seed: "seed-42" });
    expect(a.bots.assignments.map((x) => x.bot_id)).toEqual(b.bots.assignments.map((x) => x.bot_id));
    expect(a.bots.assignments.map((x) => x.seed)).toEqual(b.bots.assignments.map((x) => x.seed));

    const c = await configureBots({ root: await mk("lemma-bots-det-c-"), license: licensed, count: 3, depth: 2, scope: { p: "/x" }, tier: "pro", seed: "seed-99" });
    expect(c.bots.assignments.map((x) => x.bot_id)).not.toEqual(a.bots.assignments.map((x) => x.bot_id));
  });

  it("writes per-bot evidence and aggregate cites per-bot evidence distinguishing explored_no_finding vs found (no fabricated findings)", async () => {
    const root = await mk("lemma-bots-run-");
    await configureBots({ root, license: licensed, count: 3, depth: 2, scope: { page: "/" }, tier: "pro", seed: "seed-1" });

    const report = await runExploratoryBots({
      root,
      license: licensed,
      seed: "seed-1",
      explore: async (assignment) => {
        if (assignment.index === 1) return [{ id: "f1", title: "issue", severity: "low" }];
        return []; // explored but no finding
      },
    });

    expect(report.deterministic).toBe(true);
    expect(report.aggregate.total_bots).toBe(3);
    expect(report.aggregate.explored).toBe(3);
    expect(report.aggregate.found).toBe(1);
    expect(report.aggregate.explored_no_finding).toBe(2);

    const outcomes = report.bots.map((b) => b.outcome).sort();
    expect(outcomes).toEqual(["explored_no_finding", "explored_no_finding", "found"]);

    for (const bot of report.bots) {
      const evidenceFile = path.join(root, bot.evidence_path);
      const data = JSON.parse(await readFile(evidenceFile, "utf8"));
      expect(data.bot_id).toBe(bot.bot_id);
      expect(data.explored).toBe(true);
      expect(report.aggregate.evidence_paths).toContain(bot.evidence_path);
      if (bot.outcome === "explored_no_finding") {
        expect(bot.findings).toEqual([]);
        expect(bot.summary).toMatch(/Explored but no finding/i);
      } else {
        expect(bot.findings.length).toBeGreaterThan(0);
      }
    }

    // aggregate cites per-bot evidence
    expect(report.aggregate.evidence_paths).toHaveLength(3);
    expect(report.bots.every((b) => report.aggregate.evidence_paths.includes(b.evidence_path))).toBe(true);
  });
});
