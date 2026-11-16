import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  StateStore,
  loadSettings,
  saveSettings,
  settingsPath,
  startDashboard,
  validateSettings,
} from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function request(
  urlStr: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      { method: init?.method ?? "GET", hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: init?.headers ?? {} },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let body: any = null;
          try { body = JSON.parse(data); } catch { body = null; }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: data });
        });
      },
    );
    req.on("error", reject);
    if (init?.body) req.write(init.body);
    req.end();
  });
}

describe("LEM-146 settings", () => {
  it("validates schema and rejects invalid input", async () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(() => validateSettings({ schema_version: "x", budget: { minutes: 1, maxChecks: 1 }, focus: { project: null, url: null }, analytics: { enabled: false, endpoint: null } })).toThrow();
    expect(() => validateSettings({ schema_version: SETTINGS_SCHEMA_VERSION, budget: { minutes: -1, maxChecks: 1 }, focus: { project: null, url: null }, analytics: { enabled: false, endpoint: null } })).toThrow();
    expect(() => validateSettings({ schema_version: SETTINGS_SCHEMA_VERSION, budget: { minutes: 1, maxChecks: 1 }, focus: { project: 123, url: null }, analytics: { enabled: false, endpoint: null } })).toThrow();
    expect(() => validateSettings({ schema_version: SETTINGS_SCHEMA_VERSION, budget: { minutes: 1, maxChecks: 1 }, focus: { project: null, url: null }, analytics: { enabled: "no", endpoint: null } })).toThrow();

    const root = await mkdtemp("lemma-settings-corrupt-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await store.ensure();
    await fs.writeFile(settingsPath(store), "{not-json", "utf8");
    const err = await loadSettings(store).catch((e) => e);
    expect(err?.name ?? err?.constructor?.name).toBe("StateError");
    expect(String(err?.errorCode ?? err?.code ?? "")).toBe("state_error");
  });

  it("writes atomically, emits audited JSONL event with redacted previous/new values, and round-trips", async () => {
    const root = await mkdtemp("lemma-settings-audit-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await store.ensure();
    const next = {
      schema_version: SETTINGS_SCHEMA_VERSION,
      budget: { minutes: 5, maxChecks: 7 },
      focus: { project: "/tmp/proj", url: "https://example.test/path?token=secret" },
      analytics: { enabled: true, endpoint: "https://analytics.test/ingest?api_key=secret" },
    };
    const saved = await saveSettings(store, next, { source: "test" });
    expect(saved).toEqual(next);

    // atomic write target exists and is valid JSON
    const raw = await fs.readFile(settingsPath(store), "utf8");
    expect(JSON.parse(raw)).toEqual(next);

    const loaded = await loadSettings(store);
    expect(loaded).toEqual(next);

    const eventsRaw = await fs.readFile(store.eventsPath, "utf8");
    const events = eventsRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const settingEvents = events.filter((e) => e.event === "settings_changed");
    expect(settingEvents.length).toBeGreaterThanOrEqual(1);
    const ev = settingEvents[settingEvents.length - 1]!;
    expect(ev.path).toBe(".lemma/settings.json");
    const evText = JSON.stringify(ev);
    expect(evText).not.toContain("secret"); // redacted
    expect(ev.next.analytics.endpoint).not.toContain("secret");
    expect(ev.next.focus.url).not.toContain("secret");
  });

  it("dashboard GET/POST /settings is token-protected, validates input with typed 400 JSON, and shares state file (CLI/dashboard parity)", async () => {
    const root = await mkdtemp("lemma-settings-dash-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await store.ensure();

    // simulate CLI write to shared state file
    const cliWritten = await saveSettings(store, {
      schema_version: SETTINGS_SCHEMA_VERSION,
      budget: { minutes: 12, maxChecks: 34 },
      focus: { project: "proj-a", url: null },
      analytics: { enabled: false, endpoint: null },
    }, { source: "cli" });

    const handle = await startDashboard({ stateStore: store, host: "127.0.0.1" });
    try {
      const port = new URL(handle.url).port;
      const base = `http://127.0.0.1:${port}`;

      const unauth = await request(`${base}/settings?format=json`);
      expect(unauth.status).toBe(401);

      const getRes = await request(`${base}/settings?format=json&token=${handle.token}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.ok).toBe(true);
      expect(getRes.body.settings).toEqual(cliWritten); // dashboard reads same state file

      const invalid = await request(`${base}/settings?token=${handle.token}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lemma-dashboard-token": handle.token },
        body: JSON.stringify({ schema_version: SETTINGS_SCHEMA_VERSION, budget: { minutes: -5, maxChecks: 1 }, focus: { project: null, url: null }, analytics: { enabled: false, endpoint: null } }),
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.ok).toBe(false);
      expect(invalid.body.error).toBe("state_error");
      expect(typeof invalid.body.message).toBe("string");

      const updated = {
        schema_version: SETTINGS_SCHEMA_VERSION,
        budget: { minutes: 3, maxChecks: 9 },
        focus: { project: "proj-b", url: "https://x.test" },
        analytics: { enabled: true, endpoint: null },
      };
      const postRes = await request(`${base}/settings?token=${handle.token}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lemma-dashboard-token": handle.token, "origin": "http://127.0.0.1" },
        body: JSON.stringify(updated),
      });
      expect(postRes.status).toBe(200);
      expect(postRes.body.ok).toBe(true);
      expect(postRes.body.settings).toEqual(updated);

      // CLI/core read sees dashboard write (same state file)
      const disk = JSON.parse(await fs.readFile(settingsPath(store), "utf8"));
      expect(disk).toEqual(updated);
      expect(await loadSettings(store)).toEqual(updated);
    } finally {
      await handle.close();
    }
  });
});
