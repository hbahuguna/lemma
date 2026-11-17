import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProUnavailableError, buildEvidenceBundle, isNoPersonaReaction, validateEvidenceBundle } from "../../src/index.js";

const dirs: string[] = [];
async function mk(prefix: string) { const d = await mkdtemp(path.join(tmpdir(), prefix)); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const licensed = { verification: true };

function loadSchema() {
  // schema lives at repo root schemas/pro/evidence_bundle.v1.json
  return JSON.parse(require("node:fs").readFileSync(path.resolve(process.cwd(), "../../schemas/pro/evidence_bundle.v1.json"), "utf8"));
}

function checkAgainstSchema(bundle: any, schema: any): string[] {
  const errs: string[] = [];
  for (const k of schema.required || []) if (!(k in bundle)) errs.push(`missing:${k}`);
  if (bundle.schema_version !== schema.properties.schema_version.const) errs.push("schema_version");
  if (!schema.properties.pass_fail.enum.includes(bundle.pass_fail)) errs.push("pass_fail");
  if (!Array.isArray(bundle.screenshots)) errs.push("screenshots");
  for (const s of bundle.screenshots || []) {
    if (typeof s.path !== "string") errs.push("s.path");
    if (!Array.isArray(s.annotations)) errs.push("s.annotations");
    for (const a of s.annotations || []) {
      for (const req of ["region", "label", "note"]) if (!(req in a)) errs.push(`a.${req}`);
      if (!a.region || typeof a.region !== "object") errs.push("a.region.type");
      if (typeof a.label !== "string") errs.push("a.label.type");
      if (typeof a.note !== "string") errs.push("a.note.type");
    }
  }
  if (!(bundle.persona_reaction === null || typeof bundle.persona_reaction === "object")) errs.push("persona_reaction");
  return errs;
}

describe("LEM-200 annotated evidence bundle", () => {
  it("license gate: unlicensed returns ProUnavailableError", async () => {
    const root = await mk("lemma-eb-lic-");
    await expect(buildEvidenceBundle({ root, license: null, finding: { id: "f1", run_id: "r1", severity: "high" } })).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("builds bundle validated against schema with structured annotations and stores via atomic writes", async () => {
    const root = await mk("lemma-eb-ok-");
    const bundle = await buildEvidenceBundle({
      root,
      license: licensed,
      finding: { id: "finding-1", run_id: "run-123", severity: "high", status: "fail" },
      screenshots: [
        { path: "shots/a.png", annotations: [{ region: { x: 1, y: 2, w: 3, h: 4 }, label: "Button", note: "Misaligned" }] },
        "shots/b.png",
      ],
      persona: { id: "ux-reviewer", contract: { id: "ux-reviewer", version: "1.0" }, reaction: "Confusing CTA placement" },
    });

    expect(validateEvidenceBundle(bundle)).toEqual([]);
    const schema = loadSchema();
    expect(checkAgainstSchema(bundle, schema)).toEqual([]);
    expect(bundle.schema_version).toBe("lemma.pro.evidence_bundle/v1");
    expect(bundle.severity).toBe("high");
    expect(bundle.pass_fail).toBe("fail");
    expect(bundle.screenshots[0]!.annotations[0]).toEqual({ region: { x: 1, y: 2, w: 3, h: 4 }, label: "Button", note: "Misaligned" });
    expect(bundle.evidence_fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const bundleDir = path.join(root, ".lemma", "evidence", "run-123", "bundle", "finding-1");
    const stored = JSON.parse(await readFile(path.join(bundleDir, "bundle.json"), "utf8"));
    const ann = JSON.parse(await readFile(path.join(bundleDir, "annotations.json"), "utf8"));
    expect(stored.finding_id).toBe("finding-1");
    expect(stored.bundle_dir).toBe(path.join(".lemma", "evidence", "run-123", "bundle", "finding-1"));
    expect(ann.screenshots[0].annotations[0].label).toBe("Button");
  });

  it("records persona reaction only when persona contract attached; missing persona is null and reported as 'no persona reaction' (never fabricated)", async () => {
    const root = await mk("lemma-eb-persona-");
    const withPersona = await buildEvidenceBundle({
      root,
      license: licensed,
      finding: { id: "f2", run_id: "r2", severity: "medium", pass: true },
      screenshots: [],
      persona: { id: "security", contract: { id: "security" }, text: "Looks safe." },
    });
    expect(withPersona.persona_reaction).toEqual({ persona_id: "security", text: "Looks safe.", attributed: true, contract: { id: "security" } });
    expect(withPersona.persona_reaction_status).toBe("attributed");

    const withoutPersona = await buildEvidenceBundle({
      root,
      license: licensed,
      finding: { id: "f3", run_id: "r2", severity: "low", status: "fail" },
      screenshots: [],
    });
    expect(withoutPersona.persona_reaction).toBeNull();
    expect(withoutPersona.persona_reaction_status).toMatch(/no persona reaction/i);
    expect(isNoPersonaReaction(withoutPersona)).toBe(true);
  });
});
