import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { StateError, atomicWriteJson, ensureDir, readJsonFile, redactText, redactUnknown } from "@lemma/core";

import { ProUnavailableError, isProLicensed, type ProLicenseContext } from "./entitlement.js";

export const STEERED_PLAN_SCHEMA_VERSION = "lemma.pro.steered_plan/v1" as const;
export const STEERED_PLAN_RELATIVE_PATH = path.join(".lemma", "pro", "plan.json");
export const STEERED_PLAN_AUDIT_RELATIVE_PATH = path.join(".lemma", "pro", "plan.audit.jsonl");

export const MAX_UPLOAD_BYTES_DEFAULT = 256 * 1024; // 256 KiB, size-bounded
export const MAX_UPLOADS_PER_KIND_DEFAULT = 50;

export interface SteeredPlanUpload {
  id: string;
  kind: "spec" | "doc";
  name: string;
  hash: string; // sha256 hex
  size: number;
  content_type?: string;
  redacted: boolean;
  stored: false; // raw content never stored
  reference: string; // hash reference
  added_at: string;
  [key: string]: unknown;
}

export interface SteeredPlan {
  schema_version: typeof STEERED_PLAN_SCHEMA_VERSION;
  features: Array<Record<string, unknown>>;
  checks: Array<Record<string, unknown>>;
  personas: Array<Record<string, unknown>>;
  test_cases: Array<Record<string, unknown>>;
  bots: Record<string, unknown>;
  uploads: {
    specs: SteeredPlanUpload[];
    docs: SteeredPlanUpload[];
  };
  context: {
    connection: Record<string, unknown>;
    [key: string]: unknown;
  };
  updated_at?: string;
  [key: string]: unknown;
}

export interface SteeredPlanSchema {
  $schema: string;
  $id: string;
  title: string;
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
}

export const steeredPlanSchema: SteeredPlanSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://lemma.dev/schemas/pro/steered_plan.v1.json",
  title: "Lemma Pro Steered Test Plan v1",
  type: "object",
  required: ["schema_version", "features", "checks", "personas", "test_cases", "bots", "uploads", "context"],
  properties: {
    schema_version: { const: STEERED_PLAN_SCHEMA_VERSION },
    features: { type: "array", items: { type: "object" } },
    checks: { type: "array", items: { type: "object" } },
    personas: { type: "array", items: { type: "object" } },
    test_cases: { type: "array", items: { type: "object" } },
    bots: { type: "object" },
    uploads: {
      type: "object",
      properties: {
        specs: { type: "array", items: { type: "object" } },
        docs: { type: "array", items: { type: "object" } },
      },
    },
    context: { type: "object", properties: { connection: { type: "object" } } },
  },
};

function nowIso() { return new Date().toISOString(); }

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];
}

export function createDefaultSteeredPlan(): SteeredPlan {
  return {
    schema_version: STEERED_PLAN_SCHEMA_VERSION,
    features: [],
    checks: [],
    personas: [],
    test_cases: [],
    bots: {},
    uploads: { specs: [], docs: [] },
    context: { connection: {} },
    updated_at: nowIso(),
  };
}

export function normalizeSteeredPlan(input: unknown): SteeredPlan {
  const base = createDefaultSteeredPlan();
  if (!input || typeof input !== "object" || Array.isArray(input)) return base;
  const p = input as Record<string, unknown>;
  const uploads = (p.uploads && typeof p.uploads === "object" && !Array.isArray(p.uploads)) ? p.uploads as Record<string, unknown> : {};
  const context = (p.context && typeof p.context === "object" && !Array.isArray(p.context)) ? p.context as Record<string, unknown> : {};
  const conn = (context.connection && typeof context.connection === "object" && !Array.isArray(context.connection)) ? context.connection as Record<string, unknown> : {};
  return {
    ...base,
    ...p,
    schema_version: STEERED_PLAN_SCHEMA_VERSION,
    features: asArray(p.features),
    checks: asArray(p.checks),
    personas: asArray(p.personas),
    test_cases: asArray(p.test_cases),
    bots: (p.bots && typeof p.bots === "object" && !Array.isArray(p.bots)) ? (redactUnknown(p.bots) as Record<string, unknown>) : {},
    uploads: {
      specs: asArray(uploads.specs).map((u) => redactUnknown(u) as SteeredPlanUpload),
      docs: asArray(uploads.docs).map((u) => redactUnknown(u) as SteeredPlanUpload),
    },
    context: { ...redactUnknown(context) as Record<string, unknown>, connection: redactUnknown(conn) as Record<string, unknown> },
    updated_at: typeof p.updated_at === "string" ? p.updated_at : (base.updated_at as string),
  };
}

export function validateSteeredPlan(plan: unknown): string[] {
  const errors: string[] = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["plan must be an object"];
  const p = plan as Record<string, unknown>;
  if (p.schema_version !== STEERED_PLAN_SCHEMA_VERSION) errors.push("schema_version invalid");
  for (const k of ["features", "checks", "personas", "test_cases"] as const) if (!Array.isArray(p[k])) errors.push(`${k} must be array`);
  if (!p.bots || typeof p.bots !== "object" || Array.isArray(p.bots)) errors.push("bots must be object");
  if (!p.uploads || typeof p.uploads !== "object" || Array.isArray(p.uploads)) errors.push("uploads must be object");
  if (!p.context || typeof p.context !== "object" || Array.isArray(p.context)) errors.push("context must be object");
  return errors;
}

export interface UploadInput {
  kind: "spec" | "doc";
  name: string;
  content: string | Uint8Array;
  content_type?: string;
}

export interface ProcessUploadOptions {
  maxBytes?: number;
  maxUploadsPerKind?: number;
}

function looksLikeCredential(text: string): boolean {
  return /(authorization\s*:|bearer\s+[a-z0-9._\-]+|api[_-]?key|secret|password|token\s*=|private key|-----begin)/i.test(text);
}

export function processUpload(input: UploadInput, existing: SteeredPlanUpload[], options: ProcessUploadOptions = {}): SteeredPlanUpload {
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES_DEFAULT;
  const maxUploads = options.maxUploadsPerKind ?? MAX_UPLOADS_PER_KIND_DEFAULT;
  if (input.kind !== "spec" && input.kind !== "doc") throw new StateError("Upload kind must be spec or doc");
  const name = String(input.name || "upload").slice(0, 200);
  const bytes = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : Buffer.from(input.content);
  if (bytes.byteLength <= 0) throw new StateError("Upload is empty");
  if (bytes.byteLength > maxBytes) throw new StateError(`Upload exceeds max size (${bytes.byteLength} > ${maxBytes})`, { code: "policy_error", details: { maxBytes, size: bytes.byteLength } });
  if (existing.length >= maxUploads) throw new StateError(`Too many uploads for kind '${input.kind}'`, { code: "policy_error", details: { maxUploads } });

  // Redact sensitive content; raw credentials/content are never stored.
  const text = bytes.toString("utf8");
  const redactedText = redactText(text);
  const redacted = redactedText !== text || looksLikeCredential(text);
  const hash = createHash("sha256").update(redactedText, "utf8").digest("hex");

  const meta: SteeredPlanUpload = {
    id: `upl_${hash.slice(0, 16)}`,
    kind: input.kind,
    name: redactText(name),
    hash,
    size: Buffer.byteLength(redactedText, "utf8"),
    ...(input.content_type ? { content_type: String(input.content_type).slice(0, 120) } : {}),
    redacted,
    stored: false,
    reference: `sha256:${hash}`,
    added_at: nowIso(),
  };
  // never include raw content
  return meta;
}

export interface SteeredPlanStoreOptions {
  root?: string;
  license?: ProLicenseContext | null;
}

export class SteeredPlanStore {
  readonly root: string;
  readonly planPath: string;
  readonly auditPath: string;
  readonly proDir: string;

  constructor(options: SteeredPlanStoreOptions = {}) {
    this.root = path.resolve(options.root ?? process.cwd());
    this.proDir = path.join(this.root, ".lemma", "pro");
    this.planPath = path.join(this.root, STEERED_PLAN_RELATIVE_PATH);
    this.auditPath = path.join(this.root, STEERED_PLAN_AUDIT_RELATIVE_PATH);
  }

  async ensure(): Promise<void> {
    await ensureDir(this.proDir);
  }

  async load(): Promise<SteeredPlan> {
    await this.ensure();
    try {
      const raw = await readJsonFile<unknown>(this.planPath);
      return normalizeSteeredPlan(raw);
    } catch (e) {
      // if missing, initialize default (persisted only on explicit save/change)
      if (e instanceof StateError && /not found/i.test(e.message)) return createDefaultSteeredPlan();
      throw e;
    }
  }

  private async audit(event: Record<string, unknown>): Promise<void> {
    await this.ensure();
    const entry = redactUnknown({ ts: nowIso(), schema_version: "lemma.pro.steered_plan_audit/v1", ...event });
    await fs.appendFile(this.auditPath, JSON.stringify(entry) + "\n", "utf8");
  }

  async save(plan: unknown, opts?: { reason?: string; actor?: string }): Promise<SteeredPlan> {
    await this.ensure();
    const normalized = normalizeSteeredPlan(plan);
    const errs = validateSteeredPlan(normalized);
    if (errs.length) throw new StateError(`Invalid steered plan: ${errs.join("; ")}`, { code: "state_error", details: { errors: errs } });
    normalized.updated_at = nowIso();
    await atomicWriteJson(this.planPath, normalized);
    await this.audit({ action: "save", reason: opts?.reason ?? "update", actor: opts?.actor ?? "user", plan_hash: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") });
    return normalized;
  }

  async addUpload(upload: UploadInput, opts?: { actor?: string }): Promise<{ plan: SteeredPlan; upload: SteeredPlanUpload }> {
    const plan = await this.load();
    const list = upload.kind === "spec" ? plan.uploads.specs : plan.uploads.docs;
    const meta = processUpload(upload, list);
    if (upload.kind === "spec") plan.uploads.specs = [...list, meta]; else plan.uploads.docs = [...list, meta];
    const saved = await this.save(plan, opts?.actor ? { reason: `upload:${upload.kind}`, actor: opts.actor } : { reason: `upload:${upload.kind}` });
    await this.audit({ action: "upload", kind: upload.kind, ref: meta.reference, hash: meta.hash, size: meta.size, redacted: meta.redacted });
    return { plan: saved, upload: meta };
  }

  async update(partial: Partial<SteeredPlan>, opts?: { reason?: string; actor?: string }): Promise<SteeredPlan> {
    const current = await this.load();
    const merged = normalizeSteeredPlan({ ...current, ...partial, uploads: { ...current.uploads, ...(partial.uploads ?? {}) }, context: { ...current.context, ...(partial.context ?? {}) } });
    return this.save(merged, opts?.actor ? { reason: opts?.reason ?? "update", actor: opts.actor } : { reason: opts?.reason ?? "update" });
  }
}

export function requireSteeredPlanLicense(license: ProLicenseContext | null | undefined): void {
  // unlicensed use returns/throws ProUnavailableError per AC
  if (!isProLicensed(license ?? null)) {
    throw new ProUnavailableError("steered test plan (/plan)");
  }
}
