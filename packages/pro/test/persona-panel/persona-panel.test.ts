import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lintPersonas } from "@lemma/core";
import {
  DOCUMENTED_PANEL_MAX_SIZE,
  ProUnavailableError,
  addPersona,
  generatePanel,
  isProPersonaOptedIn,
  listProPersonas,
  setProPersonaOptIn,
} from "../../src/index.js";

const dirs: string[] = [];
async function mk(prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const licensed = { verification: true };

function sampleContract(id: string, check: string, domain = "custom") {
  return `---
id: ${id}
name: ${id}
version: 1.0
domains:
  - ${domain}
tools:
  - source_inventory
checks:
  - ${check}
---

## Role

Test custom persona.

## Available tools

| Tool | Use | Boundary |
| --- | --- | --- |
| \`source_inventory\` | Read-only inspection. | Read-only. |

## Output schema

\`\`\`json
{
  "type": "object",
  "title": "Finding",
  "required": ["title", "severity", "domain", "strength", "consequence", "location", "reproduction", "remediation", "verification"],
  "properties": {
    "title": { "type": "string" },
    "severity": { "type": "string", "enum": ["critical", "high", "medium", "low", "info"] },
    "domain": { "type": "string", "enum": ["${domain}"] },
    "strength": { "type": "string", "enum": ["observed", "source_proven", "suspected"] },
    "consequence": { "type": "string" },
    "location": { "type": "string" },
    "reproduction": { "type": "string" },
    "remediation": { "type": "string" },
    "verification": { "type": "string" }
  }
}
\`\`\`

## Blocker schema

\`\`\`json
{
  "type": "object",
  "title": "Blocker",
  "required": ["persona", "check_id", "attempted_action", "boundary", "unblock_evidence", "covered_elsewhere"],
  "properties": {
    "persona": { "type": "string" },
    "check_id": { "type": "string" },
    "attempted_action": { "type": "string" },
    "boundary": { "type": "string" },
    "unblock_evidence": { "type": "array", "items": { "type": "string" } },
    "covered_elsewhere": { "type": "boolean" }
  }
}
\`\`\`

## Refusal handling

Refuse with blocker when evidence is unavailable.
`;
}

describe("LEM-198 custom persona panel", () => {
  it("license gate: unlicensed addPersona/generatePanel return ProUnavailableError", async () => {
    const root = await mk("lemma-persona-lic-");
    await expect(addPersona({ root, license: null, contract: sampleContract("a", "pro.a.check") })).rejects.toBeInstanceOf(ProUnavailableError);
    await expect(generatePanel({ root, license: null, size: 2, diversity: 2 })).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("addPersona validates contract, persists under .lemma/pro/personas and is opt-in per run", async () => {
    const root = await mk("lemma-persona-add-");
    const res = await addPersona({ root, license: licensed, contract: sampleContract("custom-a", "pro.custom_a.check"), optIn: false });
    expect(res.persona.id).toBe("custom-a");
    expect(res.persona.opt_in).toBe(false);
    const p = path.join(root, ".lemma", "pro", "personas", "custom-a.md");
    expect((await stat(p)).isFile()).toBe(true);

    const manifest = await listProPersonas({ root, license: licensed });
    expect(manifest.personas["custom-a"]).toBeTruthy();

    const opted = await setProPersonaOptIn({ root, license: licensed, personaId: "custom-a", optIn: true, runId: "run-1" });
    expect(isProPersonaOptedIn(opted, "run-1")).toBe(true);
    expect(isProPersonaOptedIn({ ...opted, opt_in: false, opt_in_runs: [] }, "run-2")).toBe(false);
  });

  it("enforces ownership rules: custom persona must own at least one check and ownership remains disjoint", async () => {
    const root = await mk("lemma-persona-own-");
    await addPersona({ root, license: licensed, contract: sampleContract("p1", "pro.p1.unique") });
    // duplicate ownership/disjoint violation
    await expect(addPersona({ root, license: licensed, contract: sampleContract("p2", "pro.p1.unique") })).rejects.toThrow(/disjoint|claimed|duplicate/i);

    // must own at least one check
    const noChecks = sampleContract("p3", "pro.p3.x").replace(/checks:\n  - pro\.p3\.x\n/, "checks: []\n");
    await expect(addPersona({ root, license: licensed, contract: noChecks })).rejects.toThrow(/at least one check/i);
  });

  it("generatePanel produces valid lint-passing personas, bounded by documented maxSize, persisted and opt-in", async () => {
    const root = await mk("lemma-persona-panel-");
    const out = await generatePanel({ root, license: licensed, size: 3, diversity: 3, seed: 7, optIn: false });
    expect(out.personas).toHaveLength(3);
    expect(out.lint.status).toBe("valid");
    expect(out.maxSize).toBe(DOCUMENTED_PANEL_MAX_SIZE);

    const dir = path.join(root, ".lemma", "pro", "personas");
    const lint = await lintPersonas(dir, new Set(out.personas.flatMap((p) => p.checks)));
    // generated personas pass lint; ownership/disjoint satisfied
    expect(lint.errors.filter((e) => e.code === "duplicate_ownership").length).toBe(0);

    const manifest = await listProPersonas({ root, license: licensed });
    for (const p of out.personas) {
      expect(manifest.personas[p.id]).toBeTruthy();
      expect(manifest.personas[p.id]!.opt_in).toBe(false);
      const content = await readFile(p.file, "utf8");
      expect(content).toContain("id: " + p.id);
    }

    // bounded
    const big = await generatePanel({ root: await mk("lemma-persona-bound-"), license: licensed, size: 100, diversity: 4, maxSize: 5 });
    expect(big.personas.length).toBe(5);
    expect(big.bounded).toBe(true);
  });
});
