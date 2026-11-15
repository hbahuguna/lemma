import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLUGIN_TRUST_FILE,
  PLUGIN_SIGNATURE_SCHEME,
  PluginError,
  definePluginDefinition,
  loadTrustKeys,
  parsePluginSignature,
  resolvePluginTrustFile,
  saveTrustKeys,
  signPlugin,
  signaturePayload,
  verifyPluginSignature,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-plugin-trust-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("LEM-079 HMAC trust store and signing helper", () => {
  it("resolves default trust file and round-trips keys via save/load", async () => {
    await withTempDir(async (root) => {
      const resolved = resolvePluginTrustFile(root);
      expect(resolved).toBe(path.join(path.resolve(root), DEFAULT_PLUGIN_TRUST_FILE));
      expect(existsSync(resolved)).toBe(false);

      const out = saveTrustKeys(resolved, { "b-key": "secret-b", "a-key": "secret-a", empty: "" });
      expect(out).toBe(resolved);
      const raw = await readFile(resolved, "utf8");
      expect(JSON.parse(raw)).toEqual({ keys: { "a-key": "secret-a", "b-key": "secret-b" } });

      expect(loadTrustKeys(resolved)).toEqual({ "a-key": "secret-a", "b-key": "secret-b" });

      // compatible plain-object form
      await writeFile(resolved, JSON.stringify({ "x-key": "x" }), "utf8");
      expect(loadTrustKeys(resolved)).toEqual({ "x-key": "x" });
    });
  });

  it("handles missing and malformed trust stores safely", async () => {
    await withTempDir(async (root) => {
      const missing = path.join(root, ".lemma", "plugins", "trusted_keys.json");
      expect(loadTrustKeys(missing)).toEqual({});

      const bad = path.join(root, "bad-trust.json");
      await writeFile(bad, "{not-json", "utf8");
      const warnings: string[] = [];
      expect(loadTrustKeys(bad, (m) => warnings.push(m))).toEqual({});
      expect(warnings.length).toBeGreaterThan(0);

      const needsKeys = path.join(root, "needs-keys.json");
      await writeFile(needsKeys, JSON.stringify({ keys: "nope" }), "utf8");
      const warnings2: string[] = [];
      expect(loadTrustKeys(needsKeys, (m) => warnings2.push(m))).toEqual({});
      expect(warnings2.some((m) => m.includes("keys"))).toBe(true);
    });
  });

  it("produces deterministic HMAC-SHA256 signatures and verifies/parses them", async () => {
    await withTempDir(() => {
      const def = definePluginDefinition({
        id: "example.signed",
        title: "Signed",
        domain: "functional",
        expected: "Signed",
        kind: "plugin",
        requires: "any",
        base_weight: 1,
      });
      const payload = signaturePayload(def, "pkg:PLUGIN");
      expect(payload).toBeInstanceOf(Buffer);
      expect(payload.toString("utf8")).toContain("\"id\":\"example.signed\"");

      const sig = signPlugin(def, "pkg:PLUGIN", "k1", "secret");
      expect(sig.startsWith(`${PLUGIN_SIGNATURE_SCHEME}:k1:`)).toBe(true);
      expect(signPlugin(def, "pkg:PLUGIN", "k1", "secret")).toBe(sig);

      const parsed = parsePluginSignature(sig);
      expect(parsed).toEqual({ keyId: "k1", digest: sig.split(":")[2] });

      expect(verifyPluginSignature(def, "pkg:PLUGIN", sig, { k1: "secret" })).toEqual({ valid: true, keyId: "k1" });
      expect(verifyPluginSignature(def, "pkg:PLUGIN", sig, { k2: "secret" }).valid).toBe(false);
      expect(verifyPluginSignature(def, "pkg:PLUGIN", sig, { k1: "wrong" }).valid).toBe(false);
      expect(verifyPluginSignature(def, "pkg:PLUGIN", "bad-format", { k1: "secret" }).valid).toBe(false);

      expect(() => parsePluginSignature("nope")).toThrow(PluginError);
      expect(() => parsePluginSignature("sha256:k1:abc")).toThrow(PluginError);
      return Promise.resolve();
    });
  });
});
