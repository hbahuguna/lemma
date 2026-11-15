import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { StateError } from "./errors.js";
import { Severity, Strength, type Finding } from "./models.js";
import { atomicWriteJson, ensureDir } from "./state.js";

export const SUPPRESSION_SCHEMA = "quality-harness.suppressions/v1" as const;

export interface SuppressionRecord {
  fingerprint: string;
  owner: string;
  reason: string;
  ticket: string;
  expires_at: string;
  created_at: string;
}

export interface SuppressionDocument {
  schema_version: typeof SUPPRESSION_SCHEMA;
  suppressions: SuppressionRecord[];
}

export interface ApplySuppressionsResult {
  findings: Finding[];
  activeSuppressions: Record<string, SuppressionRecord>;
  expiredFingerprints: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIsoTimestamp(value: string, label: string): Date {
  const text = String(value || "").trim();
  if (!text) {
    throw new StateError(`${label} is required.`, { details: { field: label } });
  }
  const normalized = text.includes("Z") || /[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    throw new StateError(`${label} must be an ISO-8601 timestamp.`, { details: { value } });
  }
  return d;
}

function toIsoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function appendAuditEvent(eventsPath: string, event: Record<string, unknown>): Promise<void> {
  try {
    await ensureDir(path.dirname(eventsPath));
    const record = { ...event };
    if (record.timestamp === undefined || record.timestamp === null || record.timestamp === "") {
      record.timestamp = new Date().toISOString();
    }
    await fs.appendFile(eventsPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Audit/event logging must never crash mutation flows.
  }
}

function normalizeRecord(raw: unknown): SuppressionRecord | null {
  if (!isRecord(raw)) return null;
  const fingerprint = typeof raw.fingerprint === "string" ? raw.fingerprint : "";
  if (!fingerprint) return null;
  return {
    fingerprint,
    owner: typeof raw.owner === "string" ? raw.owner : "",
    reason: typeof raw.reason === "string" ? raw.reason : "",
    ticket: typeof raw.ticket === "string" ? raw.ticket : "",
    expires_at: typeof raw.expires_at === "string" ? raw.expires_at : "",
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
  };
}

export class SuppressionStore {
  readonly root: string;
  readonly lemmaDir: string;
  readonly path: string;
  readonly eventsPath: string;

  constructor(root: string, options?: { stateDirName?: string }) {
    this.root = path.resolve(root);
    const dirName = options?.stateDirName ?? ".lemma";
    this.lemmaDir = path.join(this.root, dirName);
    this.path = path.join(this.lemmaDir, "suppressions.json");
    this.eventsPath = path.join(this.lemmaDir, "events.jsonl");
  }

  async ensure(): Promise<void> {
    await ensureDir(this.lemmaDir);
  }

  async load(): Promise<SuppressionRecord[]> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      const data = JSON.parse(raw) as unknown;
      if (!isRecord(data)) {
        throw new StateError("suppressions.json must contain a JSON object", { details: { path: this.path } });
      }
      const schema = typeof data.schema_version === "string" ? data.schema_version : SUPPRESSION_SCHEMA;
      if (schema !== SUPPRESSION_SCHEMA) {
        throw new StateError(`Unsupported suppression schema version: ${String(data.schema_version)}`, {
          details: { schema_version: data.schema_version },
        });
      }
      const recordsRaw = data.suppressions;
      if (!Array.isArray(recordsRaw)) {
        throw new StateError("suppressions must be an array", { details: { path: this.path } });
      }
      return recordsRaw.map(normalizeRecord).filter((r): r is SuppressionRecord => r !== null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      if (err instanceof StateError) throw err;
      if (err instanceof SyntaxError) {
        throw new StateError(`Could not read suppressions.json: ${err.message}`, { details: { path: this.path } });
      }
      throw new StateError(`Could not read suppressions.json: ${String(err)}`, { details: { path: this.path } });
    }
  }

  private async save(records: SuppressionRecord[]): Promise<void> {
    await this.ensure();
    const doc: SuppressionDocument = { schema_version: SUPPRESSION_SCHEMA, suppressions: records };
    await atomicWriteJson(this.path, doc);
  }

  async add(
    fingerprintInput: string,
    ownerInput: string,
    reasonInput: string,
    ticketInput = "",
    expiresAtInput = "",
    nowInput?: string | Date,
  ): Promise<SuppressionRecord> {
    const fingerprint = String(fingerprintInput || "").trim();
    const owner = String(ownerInput || "").trim();
    const reason = String(reasonInput || "").trim();
    const ticket = String(ticketInput || "").trim();
    if (!fingerprint) throw new StateError("Suppression fingerprint is required.");
    if (!owner) throw new StateError("Suppression owner is required.");
    if (!reason) throw new StateError("Suppression reason is required.");

    const expiry = parseIsoTimestamp(String(expiresAtInput || ""), "Suppression expiry");
    const now = nowInput === undefined ? new Date() : nowInput instanceof Date ? nowInput : new Date(nowInput);
    if (Number.isNaN(now.getTime())) {
      throw new StateError("Invalid suppression 'now' timestamp", { details: { now: nowInput } });
    }
    if (expiry.getTime() <= now.getTime()) {
      throw new StateError("Suppression expiry must be in the future.");
    }

    const record: SuppressionRecord = {
      fingerprint,
      owner,
      reason,
      ticket,
      expires_at: toIsoUtc(expiry),
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    const records = (await this.load()).filter((item) => item.fingerprint !== fingerprint);
    records.push(record);
    await this.save(records);
    await appendAuditEvent(this.eventsPath, {
      event: "suppression_added",
      fingerprint,
      owner,
      ticket,
      expires_at: record.expires_at,
      reason,
    });
    return record;
  }

  async remove(fingerprintInput: string): Promise<SuppressionRecord> {
    const fingerprint = String(fingerprintInput || "").trim();
    if (!fingerprint) throw new StateError("Suppression fingerprint is required.");
    const records = await this.load();
    const removed = records.filter((item) => item.fingerprint === fingerprint);
    if (removed.length === 0) {
      throw new StateError(`No suppression found for fingerprint: ${fingerprint}`);
    }
    const kept = records.filter((item) => item.fingerprint !== fingerprint);
    await this.save(kept);
    await appendAuditEvent(this.eventsPath, {
      event: "suppression_removed",
      fingerprint,
    });
    return removed[removed.length - 1]!;
  }

  async activeAndExpired(nowInput?: string | Date): Promise<{ active: Record<string, SuppressionRecord>; expired: string[] }> {
    const now = nowInput === undefined ? new Date() : nowInput instanceof Date ? nowInput : new Date(nowInput);
    const effectiveNow = Number.isNaN(now.getTime()) ? new Date() : now;
    const active: Record<string, SuppressionRecord> = {};
    const expired: string[] = [];
    for (const record of await this.load()) {
      const fingerprint = record.fingerprint;
      if (!fingerprint) continue;
      try {
        const expires = parseIsoTimestamp(record.expires_at, "Suppression expiry");
        if (expires.getTime() > effectiveNow.getTime()) {
          active[fingerprint] = record;
        } else {
          expired.push(fingerprint);
        }
      } catch {
        expired.push(fingerprint);
      }
    }
    return { active, expired };
  }
}

export function makeExpiredSuppressionFinding(fingerprint: string, createdAt?: string): Finding {
  return {
    id: `finding_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    title: `Expired suppression: ${fingerprint}`,
    severity: Severity.LOW,
    domain: "functional",
    persona: "functional",
    strength: Strength.SOURCE_PROVEN,
    consequence: "A previously suppressed finding has re-entered scoring because its suppression expired.",
    location: `suppression:${fingerprint}`,
    reproduction: "",
    evidence: [],
    remediation: "Renew the suppression with a new owner/reason/expiry or address the underlying finding.",
    verification: "Re-run and confirm the finding is resolved or intentionally re-suppressed.",
    check_id: "",
    created_at: createdAt ?? new Date().toISOString(),
    tags: ["suppression", "expired"],
    fingerprint: `suppression-expired:${fingerprint}`,
    suppressed: false,
    suppression_owner: "",
    suppression_reason: "",
    suppression_ticket: "",
    suppression_expires_at: "",
  };
}

export function applySuppressionsToFindings(
  findings: readonly Finding[],
  active: Record<string, SuppressionRecord>,
  expiredFingerprints: readonly string[],
  options?: { createdAt?: string },
): ApplySuppressionsResult {
  const next: Finding[] = findings.map((finding) => {
    const record = active[finding.fingerprint];
    if (!record) {
      return {
        ...finding,
        suppressed: false,
        suppression_owner: "",
        suppression_reason: "",
        suppression_ticket: "",
        suppression_expires_at: "",
      };
    }
    return {
      ...finding,
      suppressed: true,
      suppression_owner: record.owner,
      suppression_reason: record.reason,
      suppression_ticket: record.ticket,
      suppression_expires_at: record.expires_at,
    };
  });

  const existing = new Set(next.map((f) => f.fingerprint));
  for (const fingerprint of expiredFingerprints) {
    const expiredFingerprint = `suppression-expired:${fingerprint}`;
    if (existing.has(expiredFingerprint)) continue;
    next.push(makeExpiredSuppressionFinding(fingerprint, options?.createdAt));
    existing.add(expiredFingerprint);
  }

  return { findings: next, activeSuppressions: active, expiredFingerprints: [...expiredFingerprints] };
}
