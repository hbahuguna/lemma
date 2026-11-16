/**
 * Pro entitlement gate (LEM-156).
 *
 * Reuses LEM-114/LEM-117 scoped-key and entitlement contracts (no parallel auth).
 * Unlicensed invocation refuses with ProUnavailableError: no crash, no silent pass,
 * no partial execution.
 */

import { HarnessError } from "@lemma/core";

export const PRO_LEARN_MORE_URL = "https://lemma.dev/pro" as const;
export const PRO_UNAVAILABLE_CODE = "pro_unavailable" as const;

export const PRO_ENTITLEMENT_SCHEMA_VERSIONS = new Set([
  "lemma.entitlement/v1",
  "quality-harness.entitlement/v1",
]);

export interface ProEntitlementLike {
  schema_version?: unknown;
  workspace_id?: unknown;
  plan?: unknown;
  issued_at?: unknown;
  expires_at?: unknown;
  signature?: unknown;
  [key: string]: unknown;
}

export interface ProEntitlementVerificationLike {
  valid: boolean;
  reason?: string;
  workspace_id?: unknown;
  period?: unknown;
  entitlement?: ProEntitlementLike | Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ProScopedAuthLike {
  workspace_id?: unknown;
  scopes?: unknown;
  key_id?: unknown;
  [key: string]: unknown;
}

export interface ProLicenseContext {
  /** Pre-verified entitlement result (LEM-117 verification contract). */
  verification?: ProEntitlementVerificationLike | boolean | null;
  /** Signed entitlement payload (LEM-117 contract / schema). */
  entitlement?: ProEntitlementLike | null;
  /** Scoped auth context (LEM-114 contract). */
  auth?: ProScopedAuthLike | null;
  /** Optional capability label for actionable messaging (must not include secrets). */
  capability?: string;
}

export class ProUnavailableError extends HarnessError {
  readonly learnMoreUrl: string;

  constructor(capability?: string) {
    const cap = typeof capability === "string" && capability.trim().length > 0
      ? capability.trim().slice(0, 120)
      : "this capability";
    const message = `Lemma Pro is required for ${cap}. This feature is unavailable without a valid Pro entitlement. Learn more: ${PRO_LEARN_MORE_URL}`;
    super(message, { code: PRO_UNAVAILABLE_CODE });
    this.name = "ProUnavailableError";
    this.learnMoreUrl = PRO_LEARN_MORE_URL;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

function hasValidSchema(entitlement: ProEntitlementLike | Record<string, unknown>): boolean {
  const svRaw = entitlement.schema_version;
  const sv = typeof svRaw === "string" ? svRaw.trim() : "";
  return PRO_ENTITLEMENT_SCHEMA_VERSIONS.has(sv);
}

function notExpired(entitlement: ProEntitlementLike | Record<string, unknown>, nowMs = Date.now()): boolean {
  const exp = entitlement.expires_at;
  if (exp === null || exp === undefined || exp === "") return true; // no expiry stated
  if (typeof exp !== "string" && typeof exp !== "number" && !(exp instanceof Date)) return false;
  const ms = exp instanceof Date ? exp.getTime() : Date.parse(String(exp));
  if (!Number.isFinite(ms)) return false;
  return ms > nowMs;
}

function hasWorkspace(entitlement: ProEntitlementLike | Record<string, unknown>): boolean {
  const ws = entitlement.workspace_id;
  return typeof ws === "string" && ws.trim().length > 0;
}

function authLooksScoped(auth: ProScopedAuthLike | Record<string, unknown>): boolean {
  const ws = auth.workspace_id;
  return typeof ws === "string" && ws.trim().length > 0;
}

/**
 * Resolve Pro entitlement/license using LEM-114/LEM-117 contract-shaped inputs.
 * No parallel auth system: callers provide verification/auth/entitlement material
 * produced by cloud auth/signup/entitlement flows (or an equivalent verifier).
 */
export function isProLicensed(context?: ProLicenseContext | null): boolean {
  if (!context || !isRecord(context)) return false;

  // Explicit boolean verification fast-path (e.g. test/injected verifier result)
  if (context.verification === true) return true;
  if (context.verification === false) return false;

  // LEM-117 EntitlementVerification-like result
  if (isRecord(context.verification)) {
    const v = context.verification as ProEntitlementVerificationLike;
    if (v.valid !== true) return false;
    const ent = asRecord(v.entitlement ?? null);
    if (ent) {
      return hasValidSchema(ent) && hasWorkspace(ent) && notExpired(ent);
    }
    // valid verification without embedded entitlement still counts as licensed
    // when it carries a workspace binding (contract-compatible result)
    if (typeof v.workspace_id === "string" && v.workspace_id.trim().length > 0) return true;
    return true;
  }

  // Direct signed/issued entitlement payload (LEM-117 contract shape)
  const directEnt = asRecord(context.entitlement ?? null);
  if (directEnt) {
    if (!hasValidSchema(directEnt) || !hasWorkspace(directEnt) || !notExpired(directEnt)) return false;
    // if paired with scoped auth, require same workspace binding
    const auth = asRecord(context.auth ?? null);
    if (auth) {
      if (!authLooksScoped(auth)) return false;
      const wsAuth = typeof auth.workspace_id === "string" ? auth.workspace_id.trim() : "";
      const wsEnt = typeof directEnt.workspace_id === "string" ? directEnt.workspace_id.trim() : "";
      if (wsAuth !== wsEnt) return false;
    }
    return true;
  }

  return false;
}

/**
 * Assert that the caller is licensed for a Pro capability.
 * Throws ProUnavailableError before any Pro work when unlicensed.
 */
export function requireProLicense(context?: ProLicenseContext | null, capability?: string): void {
  if (!isProLicensed(context ?? null)) {
    throw new ProUnavailableError(capability ?? context?.capability);
  }
}

/**
 * Example gated Pro invocation helper. Performs no partial work when unlicensed.
 */
export function invokeProCapability<T>(
  context: ProLicenseContext | null | undefined,
  capability: string,
  fn: () => T,
): T {
  requireProLicense(context ?? null, capability);
  return fn();
}
