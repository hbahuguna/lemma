import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  EvidenceStore,
  Orchestrator,
  RELEASE_CONFIDENCE,
  RunStatus,
  StateError,
  StateStore,
  buildRegistry,
  definePlugin,
  normalizeTarget,
  registryFingerprint,
  saveTrustKeys,
  signPlugin,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-plugin-resume-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makePluginRegistry(root: string, opts?: { id?: string; keyId?: string; secret?: string }) {
  const keyId = opts?.keyId ?? "test-key";
  const secret = opts?.secret ?? "synthetic-secret";
  const trustFile = path.join(root, ".lemma", "plugins", "trusted_keys.json");
  saveTrustKeys(trustFile, { [keyId]: secret });
  const plugin = definePlugin({
    definition: {
      id: opts?.id ?? "example.resume_plugin",
      title: "Resume plugin",
      domain: "functional",
      intent: "Exercise plugin registry fingerprinting.",
      expected: "Plugin is registered.",
      base_weight: 1,
      requires: "source",
      kind: "plugin",
    },
    evaluate: () => ({ status: "passed", actual: "ok" }) as never,
  });
  const signed = { ...plugin, signature: signPlugin(plugin.definition, "resume:PLUGIN", keyId, secret) };
  return buildRegistry({
    root,
    trustFile,
    entryPoints: [{ name: "resume", value: "resume:PLUGIN", load: () => signed }],
  });
}

async function readBytes(p: string): Promise<Buffer> {
  return readFile(p);
}

describe("LEM-081 resume protection against a changed plugin registry", () => {
  it("records plugin registry fingerprint and allows resume when unchanged", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const registry = await makePluginRegistry(dir);
      const fp = registryFingerprint(registry);
      const orch = new Orchestrator({ store });

      const state = await orch.run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: dir }),
        intent: "ship",
        workflow: RELEASE_CONFIDENCE,
        registry,
      });

      expect(state.options.registry_fingerprint).toBe(fp);
      expect(state.options.plugin_registry_fingerprint).toBe(fp);

      const resumed = await orch.run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: dir }),
        workflow: RELEASE_CONFIDENCE,
        resume: true,
        registry,
      });
      expect(resumed.run_id).toBe(state.run_id);
      expect(resumed.status).toBe(RunStatus.COMPLETED);
      expect(resumed.options.registry_fingerprint).toBe(fp);
    });
  });

  it("rejects resume on changed plugin registry without mutating progress or evidence", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const registry = await makePluginRegistry(dir);
      const orch = new Orchestrator({ store });

      const state = await orch.run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: dir }),
        intent: "ship",
        workflow: RELEASE_CONFIDENCE,
        registry,
      });

      const evidence = new EvidenceStore(dir, state.run_id);
      await evidence.init();
      const artifact = await evidence.saveText("note", "hello", "text", "x", "check.completed");
      await evidence.checkpoint();
      const progressBefore = (await readBytes(store.progressPath)).toString("utf8");
      const manifestBefore = (await readBytes(evidence.manifestPath)).toString("utf8");

      // changed plugin registry: different plugin id/set => different fingerprint
      const changed = await makePluginRegistry(dir, { id: "example.resume_plugin_changed" });
      expect(registryFingerprint(changed)).not.toBe(registryFingerprint(registry));

      await expect(
        orch.run({
          target: normalizeTarget({ raw: ".", kind: "directory", resolved: dir }),
          workflow: RELEASE_CONFIDENCE,
          resume: true,
          registry: changed,
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof StateError && /Plugin registry changed/.test(String(err)));

      expect((await readBytes(store.progressPath)).toString("utf8")).toBe(progressBefore);
      expect((await readBytes(evidence.manifestPath)).toString("utf8")).toBe(manifestBefore);
      const manifest = JSON.parse(await readFile(evidence.manifestPath, "utf8")) as { evidence: Array<{ path: string }> };
      expect(manifest.evidence.some((e) => e.path === artifact)).toBe(true);
    });
  });

  it("rejects resume when plugin trust state changes fingerprint (e.g. rotated trust key)", async () => {
    await withTempDir(async (dir) => {
      const store = new StateStore(dir);
      const registry = await makePluginRegistry(dir, { keyId: "k1", secret: "s1" });
      const orch = new Orchestrator({ store });

      await orch.run({
        target: normalizeTarget({ raw: ".", kind: "directory", resolved: dir }),
        intent: "ship",
        workflow: RELEASE_CONFIDENCE,
        registry,
      });
      const progressBefore = (await readBytes(store.progressPath)).toString("utf8");

      // different trust key id/state in registry fingerprint
      const rotated = await makePluginRegistry(dir, { keyId: "k2", secret: "s2" });
      expect(registryFingerprint(rotated)).not.toBe(registryFingerprint(registry));

      await expect(
        orch.run({
          target: normalizeTarget({ raw: ".", kind: "directory", resolved: dir }),
          workflow: RELEASE_CONFIDENCE,
          resume: true,
          registry: rotated,
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof StateError && /Plugin registry changed/.test(String(err)));

      expect((await readBytes(store.progressPath)).toString("utf8")).toBe(progressBefore);
    });
  });
});
