import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore, startDashboard } from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

function get(urlStr: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({ method: "GET", hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let body: any = null;
        try { body = JSON.parse(data); } catch { body = null; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: data });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("LEM-155 pro page", () => {
  it("requires token, renders informational pro page with no external assets", async () => {
    const root = await mkdtemp("lemma-pro-page-");
    tempDirs.push(root);
    const store = new StateStore(root);
    await store.ensure();

    const handle = await startDashboard({ stateStore: store, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${new URL(handle.url).port}`;
      const unauth = await get(`${base}/pro`);
      expect(unauth.status).toBe(401);

      const res = await get(`${base}/pro?token=${handle.token}`);
      expect(res.status).toBe(200);
      expect(String(res.headers["content-type"])).toContain("text/html");
      expect(res.text).toContain("Lemma Pro");
      expect(res.text).toContain("informational only");
      expect(res.text).toContain("does not start a checkout");
      expect(res.text).toContain("does not collect data");
      expect(res.text).toContain("does not require an account");
      expect(res.text).toContain("Pricing summary");
      expect(res.text).toContain("https://lemma.dev/pro");
      expect(res.text).not.toMatch(/<script\b/i);
      expect(res.text).not.toMatch(/<link\b/i);
      expect(res.text).not.toMatch(/<img\b/i);
      expect(res.text).not.toMatch(/\bfetch\s*\(/i);

      const alias = await get(`${base}/dashboard/pro?token=${handle.token}`);
      expect(alias.status).toBe(200);
      expect(alias.text).toContain("Lemma Pro");
    } finally {
      await handle.close();
    }
  });
});
