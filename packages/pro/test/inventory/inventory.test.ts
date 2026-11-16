import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CorruptStateError, StateError } from "@lemma/core";
import {
  ProUnavailableError,
  TEST_INVENTORY_SCHEMA_VERSION,
  inventory,
  inventoryBuild,
  inventoryRead,
  validateTestInventory,
} from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const validLicense = {
  verification: {
    valid: true,
    reason: "ok",
    workspace_id: "ws_pro_inv",
    entitlement: {
      schema_version: "quality-harness.entitlement/v1",
      workspace_id: "ws_pro_inv",
      plan: { id: "pro", version: "1" },
      issued_at: "2026-11-16T00:00:00Z",
      expires_at: "2099-11-16T00:00:00Z",
      signature: "test",
    },
  },
};

function sampleRun(runId: string, checks: Array<Record<string, unknown>>) {
  return {
    run_id: runId,
    generated_at: "2026-11-16T00:00:00Z",
    results: checks,
  };
}

describe("LEM-159 project-level test inventory", () => {
  it("rejects unlicensed build/read with ProUnavailableError and performs no reads or writes", async () => {
    const root = await mkdtemp("lemma-inv-unlicensed-");
    tempDirs.push(root);
    const invPath = path.join(root, ".lemma", "pro", "inventory.json");
    await expect(inventoryBuild({ projectRoot: root, runs: [], license: null } as any)).rejects.toBeInstanceOf(ProUnavailableError);
    const existsAfterBuild = await fs.stat(invPath).then(() => true).catch(() => false);
    expect(existsAfterBuild).toBe(false);

    // seed a file and ensure unlicensed read does not occur / leaks nothing (throws before read)
    await fs.mkdir(path.dirname(invPath), { recursive: true });
    await fs.writeFile(invPath, "{not json", "utf8");
    await expect(inventoryRead({ projectRoot: root, license: null } as any)).rejects.toBeInstanceOf(ProUnavailableError);
  });

  it("builds a versioned, schema-validated inventory aggregated per check/test with bounded recent history", async () => {
    const root = await mkdtemp("lemma-inv-build-");
    tempDirs.push(root);
    const runs = [
      sampleRun("run_1", [
        { id: "static.tests", status: "passed", persona: "functional", evidence: ["e1"], kind: "static" },
        { id: "static.secrets", status: "failed", persona: "security", evidence: ["e2"] },
      ]),
      sampleRun("run_2", [
        { id: "static.tests", status: "failed", persona: "functional", evidence: ["e3"] },
        { id: "pro.security.custom", status: "passed", persona: "pro.security", evidence: ["e4"], source: "Pro specialist" },
      ]),
      sampleRun("run_3", [
        { id: "static.tests", status: "passed", persona: "functional", evidence: ["e5"] },
      ]),
    ];

    const built = await inventoryBuild({ projectRoot: root, runs, license: validLicense as any, historyCap: 2, now: () => "2026-11-16T12:00:00Z" });
    expect(built.schema_version).toBe(TEST_INVENTORY_SCHEMA_VERSION);
    expect(built.history_cap).toBe(2);
    expect(built.runs_indexed).toEqual(["run_1", "run_2", "run_3"]);
    expect(validateTestInventory(built).schema_version).toBe(TEST_INVENTORY_SCHEMA_VERSION);

    const tests = built.checks.find((c) => c.stable_id === "static.tests");
    expect(tests).toBeTruthy();
    expect(tests!.last_seen_run_id).toBe("run_3");
    expect(tests!.last_seen_status).toBe("passed");
    expect(tests!.owner_persona).toBe("functional");
    expect(tests!.source).toBe("built-in");
    expect(tests!.evidence_fingerprint).toBeTruthy();
    // bounded recent history (cap 2), most recent first
    expect(tests!.recent_history.map((h) => h.run_id)).toEqual(["run_3", "run_2"]);
    expect(tests!.recent_history.every((h) => h.evidence_fingerprint.length > 0)).toBe(true);

    const pro = built.checks.find((c) => c.stable_id === "pro.security.custom");
    expect(pro?.source).toBe("Pro specialist");

    // persisted atomically to .lemma/pro/inventory.json
    const invPath = path.join(root, ".lemma", "pro", "inventory.json");
    const onDisk = JSON.parse(await fs.readFile(invPath, "utf8"));
    expect(onDisk.schema_version).toBe(TEST_INVENTORY_SCHEMA_VERSION);
    expect(Array.isArray(onDisk.checks)).toBe(true);
  });

  it("raises typed StateError (CorruptStateError) on corrupt reads and preserves corrupt file", async () => {
    const root = await mkdtemp("lemma-inv-corrupt-");
    tempDirs.push(root);
    const invPath = path.join(root, ".lemma", "pro", "inventory.json");
    await fs.mkdir(path.dirname(invPath), { recursive: true });
    await fs.writeFile(invPath, "{ this is not valid json", "utf8");
    await expect(inventoryRead({ projectRoot: root, license: validLicense as any })).rejects.toSatisfy((e: unknown) => e instanceof StateError || e instanceof CorruptStateError);
    // corrupt file preserved on disk (no overwrite)
    const raw = await fs.readFile(invPath, "utf8");
    expect(raw).toContain("not valid json");
  });

  it("inventory.listCheck returns matching check view", async () => {
    const root = await mkdtemp("lemma-inv-list-");
    tempDirs.push(root);
    await inventoryBuild({
      projectRoot: root,
      license: validLicense as any,
      runs: [sampleRun("run_a", [{ id: "a.check", status: "passed", persona: "functional", evidence: ["x"] }])],
    });
    const out = await inventory.listCheck({ projectRoot: root, license: validLicense as any, checkId: "a.check" } as any);
    expect(out.check?.stable_id).toBe("a.check");
    expect(out.inventory.schema_version).toBe(TEST_INVENTORY_SCHEMA_VERSION);
    const miss = await inventory.listCheck({ projectRoot: root, license: validLicense as any, checkId: "nope" } as any);
    expect(miss.check).toBeNull();
  });
});
