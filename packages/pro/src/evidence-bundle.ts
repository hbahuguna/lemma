import { createHash } from "node:crypto";
import path from "node:path";

import { StateError, atomicWriteJson, ensureDir } from "@lemma/core";

import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "./entitlement.js";

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = "lemma.pro.evidence_bundle/v1" as const;

export interface ScreenshotAnnotation {
  region: Record<string, unknown>;
  label: string;
  note: string;
  [key: string]: unknown;
}

export interface BundleScreenshot {
  path: string;
  annotations: ScreenshotAnnotation[];
  [key: string]: unknown;
}

export interface PersonaReaction {
  persona_id: string;
  text: string;
  attributed: true;
  contract?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface EvidenceBundle {
  schema_version: typeof EVIDENCE_BUNDLE_SCHEMA_VERSION;
  finding_id: string;
  run_id: string;
  severity: string;
  pass_fail: "pass" | "fail";
  screenshots: BundleScreenshot[];
  persona_reaction: PersonaReaction | null;
  persona_reaction_status: string; // e.g. "attributed" or "no persona reaction"
  evidence_fingerprint: string;
  bundle_dir: string;
  stored_at?: string;
  [key: string]: unknown;
}

export interface BuildEvidenceBundleParams {
  finding: Record<string, any>;
  screenshots?: Array<string | Record<string, any>>;
  persona?: Record<string, any> | null;
  root?: string;
  runId?: string;
  license?: ProLicenseContext | null;
}

function assertLicensed(license: ProLicenseContext | null | undefined): void {
  if (!isProLicensed(license ?? null)) throw new ProUnavailableError("annotated evidence bundle");
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function normalizeAnnotation(a: any): ScreenshotAnnotation {
  const region = a && typeof a === "object" && a.region && typeof a.region === "object" ? a.region as Record<string, unknown> : {};
  return {
    ...(a && typeof a === "object" ? a : {}),
    region,
    label: asString(a?.label, "annotation"),
    note: asString(a?.note, ""),
  };
}

function normalizeScreenshot(s: string | Record<string, any>): BundleScreenshot {
  if (typeof s === "string") {
    return { path: s, annotations: [] };
  }
  const annotationsRaw = Array.isArray(s.annotations) ? s.annotations : [];
  return {
    ...s,
    path: asString(s.path ?? s.file ?? s.src, ""),
    annotations: annotationsRaw.map(normalizeAnnotation),
  };
}

function computeFingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function validateEvidenceBundle(bundle: any): string[] {
  const errors: string[] = [];
  if (!bundle || typeof bundle !== "object") return ["bundle must be an object"];
  if (bundle.schema_version !== EVIDENCE_BUNDLE_SCHEMA_VERSION) errors.push("schema_version");
  for (const k of ["finding_id", "run_id", "severity", "bundle_dir", "evidence_fingerprint", "persona_reaction_status"]) {
    if (typeof bundle[k] !== "string" || !bundle[k]) errors.push(`missing_or_invalid:${k}`);
  }
  if (bundle.pass_fail !== "pass" && bundle.pass_fail !== "fail") errors.push("pass_fail");
  if (!Array.isArray(bundle.screenshots)) errors.push("screenshots");
  else {
    for (const s of bundle.screenshots) {
      if (!s || typeof s !== "object") { errors.push("screenshot_invalid"); continue; }
      if (typeof s.path !== "string") errors.push("screenshot.path");
      if (!Array.isArray(s.annotations)) errors.push("screenshot.annotations");
      else {
        for (const a of s.annotations) {
          if (!a || typeof a !== "object") { errors.push("annotation_invalid"); continue; }
          if (!a.region || typeof a.region !== "object") errors.push("annotation.region");
          if (typeof a.label !== "string") errors.push("annotation.label");
          if (typeof a.note !== "string") errors.push("annotation.note");
        }
      }
    }
  }
  if (!(bundle.persona_reaction === null || (bundle.persona_reaction && typeof bundle.persona_reaction === "object"))) errors.push("persona_reaction");
  if (bundle.persona_reaction === null && !/no persona reaction/i.test(String(bundle.persona_reaction_status || ""))) errors.push("persona_reaction_status_missing_persona");
  return errors;
}

function resolvePersonaReaction(persona: Record<string, any> | null | undefined): { reaction: PersonaReaction | null; status: string } {
  // Persona reaction recorded only when a persona contract is attached
  const hasContract = !!persona && typeof persona === "object" && (persona.id || persona.name || persona.contract || persona.persona || persona.role);
  if (!hasContract) {
    return { reaction: null, status: "no persona reaction" };
  }
  const personaId = asString(persona.id ?? persona.persona ?? persona.name, "persona");
  const text = asString(persona.reaction ?? persona.text ?? persona.comment ?? persona.response, `${personaId} reviewed the evidence.`);
  const reaction: PersonaReaction = {
    persona_id: personaId,
    text,
    attributed: true,
    contract: (persona.contract && typeof persona.contract === "object") ? persona.contract : (persona as Record<string, unknown>),
  };
  return { reaction, status: "attributed" };
}

export async function buildEvidenceBundle(params: BuildEvidenceBundleParams): Promise<EvidenceBundle> {
  assertLicensed(params.license);

  const root = path.resolve(params.root ?? process.cwd());
  const finding = params.finding || {};
  const runId = asString(params.runId ?? finding.run_id ?? finding.runId ?? "unknown-run");
  const findingId = asString(finding.id ?? finding.finding_id ?? finding.findingId ?? `finding-${createHash("sha256").update(JSON.stringify(finding)).digest("hex").slice(0, 8)}`);
  const severity = asString(finding.severity, "info").toLowerCase();
  const passFail: "pass" | "fail" = (finding.pass === true || finding.status === "pass" || finding.passed === true) ? "pass" : "fail";

  const screenshots = (params.screenshots || finding.screenshots || []).map(normalizeScreenshot).filter((s: BundleScreenshot) => s.path !== "");
  const { reaction, status } = resolvePersonaReaction(params.persona ?? finding.persona ?? null);

  const bundleDirRel = path.join(".lemma", "evidence", runId, "bundle", findingId);
  const bundleDirAbs = path.join(root, bundleDirRel);
  await ensureDir(bundleDirAbs);

  const fingerprintPayload = { findingId, runId, severity, passFail, screenshots, persona_reaction: reaction, persona_reaction_status: status };
  const evidence_fingerprint = computeFingerprint(fingerprintPayload);

  const bundle: EvidenceBundle = {
    schema_version: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    finding_id: findingId,
    run_id: runId,
    severity,
    pass_fail: passFail,
    screenshots,
    persona_reaction: reaction,
    persona_reaction_status: status,
    evidence_fingerprint,
    bundle_dir: bundleDirRel,
    stored_at: new Date().toISOString(),
  };

  const errors = validateEvidenceBundle(bundle);
  if (errors.length) {
    throw new StateError(`Evidence bundle failed schema validation: ${errors.join(", ")}`, { details: { errors } });
  }

  // store annotations/bundle under .lemma/evidence/<run_id>/bundle/<finding_id>/ via atomic writes
  await atomicWriteJson(path.join(bundleDirAbs, "bundle.json"), bundle);
  await atomicWriteJson(path.join(bundleDirAbs, "annotations.json"), { schema_version: EVIDENCE_BUNDLE_SCHEMA_VERSION, finding_id: findingId, run_id: runId, screenshots });

  return bundle;
}

export function isNoPersonaReaction(bundle: EvidenceBundle): boolean {
  return bundle.persona_reaction === null && /no persona reaction/i.test(bundle.persona_reaction_status);
}
