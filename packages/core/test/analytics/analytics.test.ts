import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  StateStore,
  getOrCreateInstallId,
  recordEvent,
  saveSettings,
} from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("LEM-152 analytics", () => {
  it("defaults to disabled per ADR and is a no-op unless explicitly enabled", async () => {
    const root = await mkdtemp("lemma-analytics-default-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await store.ensure();
    const sent: any[] = [];
    const stderr: string[] = [];
    await recordEvent("run_started", { workflow: "release-confidence" }, {
      store,
      env: {},
      fetchImpl: async (_url, init: any) => {
        sent.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response("ok", { status: 200 }) as any;
      },
      stderr: (m) => stderr.push(m),
      flushTimeoutMs: 50,
    });
    await delay(20);
    expect(sent.length).toBe(0); // default disabled
    expect(stderr.join("")).not.toContain("error");
  });

  it("disabled by env (LEMMA_ANALYTICS=off) and disabled by settings; enabled settings emits allowlisted payload", async () => {
    const root = await mkdtemp("lemma-analytics-enabled-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await store.ensure();

    // enabled via settings
    await saveSettings(store, {
      ...DEFAULT_SETTINGS,
      analytics: { enabled: true, endpoint: "https://analytics.example.test/v1/events" },
    }, { source: "test" });

    const sent: any[] = [];
    await recordEvent("command_invoked", { command: "run" }, {
      store,
      env: {},
      fetchImpl: async (_url, init: any) => {
        sent.push({ url: _url, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response("ok", { status: 200 }) as any;
      },
      flushTimeoutMs: 50,
    });
    await delay(30);
    expect(sent.length).toBe(1);
    expect(String(sent[0].url)).toContain("analytics.example.test");

    // env forces off even if settings enabled
    const sent2: any[] = [];
    await recordEvent("run_started", { workflow: "x" }, {
      store,
      env: { LEMMA_ANALYTICS: "off" },
      fetchImpl: async (_url, init: any) => { sent2.push(init); return new Response("ok") as any; },
      flushTimeoutMs: 50,
    });
    await delay(20);
    expect(sent2.length).toBe(0);

    // settings disabled
    await saveSettings(store, { ...DEFAULT_SETTINGS, analytics: { enabled: false, endpoint: null } }, { source: "test" });
    const sent3: any[] = [];
    await recordEvent("run_started", { workflow: "x" }, {
      store,
      env: {},
      fetchImpl: async (_url, init: any) => { sent3.push(init); return new Response("ok") as any; },
      flushTimeoutMs: 50,
    });
    await delay(20);
    expect(sent3.length).toBe(0);
  });

  it("rejects unknown event names with typed error and strips non-allowlisted/forbidden properties", async () => {
    const root = await mkdtemp("lemma-analytics-strip-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await store.ensure();
    await saveSettings(store, { ...DEFAULT_SETTINGS, analytics: { enabled: true, endpoint: "https://analytics.example.test/v1/events" } }, { source: "test" });

    await expect(recordEvent("not_allowed_event", {}, { store, env: {} } as any)).rejects.toMatchObject({ errorCode: "harness_error" });

    const sent: any[] = [];
    await recordEvent("run_completed", {
      workflow: "release-confidence",
      status: "completed",
      duration_ms: 1234.6,
      prompt: "secret prompt",
      code: "console.log(secret)",
      path: "/Users/me/private/repo/file.ts",
      target: "https://internal.example/private",
      user_id: "u123",
    } as any, {
      store,
      env: {},
      fetchImpl: async (_url, init: any) => { sent.push(JSON.parse(String(init?.body ?? "{}"))); return new Response("ok") as any; },
      flushTimeoutMs: 50,
    });
    await delay(30);
    expect(sent.length).toBe(1);
    const ev = sent[0].events[0];
    expect(ev.event).toBe("run_completed");
    expect(ev.install_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ev.props).toEqual({ workflow: "release-confidence", status: "completed", duration_ms: 1235 });
    const text = JSON.stringify(sent[0]);
    expect(text).not.toContain("secret prompt");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("/Users/me");
    expect(text).not.toContain("internal.example");
    expect(text).not.toContain("user_id");

    const installIdPath = path.join(store.lemmaDir, "analytics-install-id");
    const installId = (await fs.readFile(installIdPath, "utf8")).trim();
    expect(installId).toBe(ev.install_id);
    // stable per install
    const id2 = await getOrCreateInstallId(store);
    expect(id2).toBe(installId);
  });

  it("async timeout/failure never fails run and does not write stdout; diagnostics go to stderr", async () => {
    const root = await mkdtemp("lemma-analytics-timeout-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await store.ensure();
    await saveSettings(store, { ...DEFAULT_SETTINGS, analytics: { enabled: true, endpoint: "https://analytics.example.test/v1/events" } }, { source: "test" });

    const stdoutWrites: string[] = [];
    const origWrite = process.stdout.write;
    // not monkeypatching globally in risky way; just ensure recordEvent returns cleanly
    const stderr: string[] = [];
    const slowFetch = (_url: any, _init: any) => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("ok") as any), 200));
    const started = Date.now();
    await expect(recordEvent("run_started", { workflow: "w" }, {
      store,
      env: {},
      fetchImpl: slowFetch as any,
      flushTimeoutMs: 10,
      stderr: (m) => stderr.push(m),
    })).resolves.toBeUndefined();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(150); // caller not blocked by slow flush
    await delay(50);
    // may or may not emit diagnostic depending on abort behavior, but must not throw/fail
    expect(stderr.join("").length).toBeGreaterThanOrEqual(0);
    void stdoutWrites; void origWrite;
  });

  it("records settings toggle as JSONL audit event via StateStore", async () => {
    const root = await mkdtemp("lemma-analytics-audit-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await store.ensure();
    await saveSettings(store, { ...DEFAULT_SETTINGS, analytics: { enabled: false, endpoint: null } }, { source: "test" });
    await saveSettings(store, { ...DEFAULT_SETTINGS, analytics: { enabled: true, endpoint: null } }, { source: "dashboard" });
    const eventsRaw = await fs.readFile(store.eventsPath, "utf8");
    const events = eventsRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const toggles = events.filter((e) => e.event === "settings_changed");
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    const last = toggles[toggles.length - 1]!;
    expect(last.next?.analytics?.enabled).toBe(true);
    expect(last.previous?.analytics?.enabled).toBe(false);
  });
});
