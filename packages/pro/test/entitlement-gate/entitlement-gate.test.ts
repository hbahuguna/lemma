import { describe, expect, it } from "vitest";

import {
  PRO_LEARN_MORE_URL,
  PRO_UNAVAILABLE_CODE,
  ProUnavailableError,
  invokeProCapability,
  isProLicensed,
  requireProLicense,
} from "../../src/entitlement.js";

const validEntitlement = {
  schema_version: "quality-harness.entitlement/v1",
  workspace_id: "ws_123",
  plan: { id: "pro", version: "1" },
  issued_at: "2026-11-16T00:00:00Z",
  expires_at: "2099-11-16T00:00:00Z",
  signature: "sig",
};

describe("LEM-156 entitlement gate", () => {
  it("unlicensed invocation returns ProUnavailableError with stable code, Pro tier name, learn-more link, and no implementation details", () => {
    let err: unknown;
    try {
      requireProLicense(null, "advanced specialist command");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProUnavailableError);
    const e = err as ProUnavailableError;
    expect(e.errorCode).toBe(PRO_UNAVAILABLE_CODE);
    expect(e.message).toContain("Lemma Pro");
    expect(e.message).toContain("advanced specialist command");
    expect(e.message).toContain(PRO_LEARN_MORE_URL);
    expect(e.learnMoreUrl).toBe(PRO_LEARN_MORE_URL);
    // no implementation details / secrets
    expect(e.message.toLowerCase()).not.toContain("stack");
    expect(e.message.toLowerCase()).not.toContain("signature");
    expect(e.message.toLowerCase()).not.toContain("token");
    expect(e.message.toLowerCase()).not.toContain("secret");
    expect(e.message.toLowerCase()).not.toContain("hmac");
  });

  it("refuses without crash, without silent pass, and without partial execution", () => {
    let sideEffect = 0;
    expect(() =>
      invokeProCapability(undefined, "property proof", () => {
        sideEffect += 1;
        return "ok";
      }),
    ).toThrow(ProUnavailableError);
    expect(sideEffect).toBe(0); // no partial execution
  });

  it("accepts LEM-117-compatible verification results (reused entitlement contract)", () => {
    expect(
      isProLicensed({
        verification: {
          valid: true,
          reason: "ok",
          workspace_id: "ws_123",
          entitlement: validEntitlement,
        },
      }),
    ).toBe(true);

    expect(
      isProLicensed({
        verification: {
          valid: true,
          reason: "ok",
          workspace_id: "ws_123",
        },
      }),
    ).toBe(true);
  });

  it("accepts LEM-114/LEM-117-shaped scoped auth + entitlement binding and rejects mismatches/invalid cases", () => {
    expect(
      isProLicensed({
        auth: { workspace_id: "ws_123", scopes: ["run", "read"] },
        entitlement: validEntitlement,
      }),
    ).toBe(true);

    expect(
      isProLicensed({
        auth: { workspace_id: "ws_other", scopes: ["run"] },
        entitlement: validEntitlement,
      }),
    ).toBe(false);

    expect(isProLicensed({ verification: { valid: false, reason: "invalid" } })).toBe(false);
    expect(isProLicensed({ entitlement: { ...validEntitlement, expires_at: "2000-01-01T00:00:00Z" } })).toBe(false);
    expect(isProLicensed({ entitlement: { ...validEntitlement, schema_version: "unknown/v1" } })).toBe(false);
    expect(isProLicensed({})).toBe(false);
  });

  it("runs gated capability only when licensed", () => {
    const result = invokeProCapability(
      { verification: { valid: true, workspace_id: "ws_123", entitlement: validEntitlement } },
      "model evaluation",
      () => "executed",
    );
    expect(result).toBe("executed");
  });
});
