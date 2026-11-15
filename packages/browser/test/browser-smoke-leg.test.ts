import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CheckStatus, type Check, type CheckOutcome } from "@lemma/core";
import { runBrowserChecks } from "../src/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../..");
const demoWebDir = resolve(repoRoot, "examples/demo-web");

function contentType(p: string): string {
  switch (extname(p).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    default: return "application/octet-stream";
  }
}

async function serveDemoWeb(): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        let p = decodeURIComponent(reqUrl.pathname);
        if (p === "/") p = "/index.html";
        const filePath = resolve(demoWebDir, `.${p}`);
        if (!filePath.startsWith(demoWebDir)) {
          res.writeHead(403); res.end("forbidden"); return;
        }
        const data = await readFile(filePath);
        res.writeHead(200, { "content-type": contentType(filePath) });
        res.end(data);
      } catch {
        res.writeHead(404); res.end("not found");
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind demo-web server");
  const url = `http://127.0.0.1:${addr.port}/`;
  return {
    server,
    url,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function canLaunchPlaywrightChromium(): Promise<boolean> {
  try {
    const pw = await import("playwright");
    const chromium = (pw as { chromium?: { launch?: (opts?: unknown) => Promise<{ close: () => Promise<void> }> } }).chromium;
    if (!chromium || typeof chromium.launch !== "function") return false;
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

function makeCheck(id: string): Check {
  return {
    id,
    title: id,
    domain: "functional",
    persona: "functional",
    kind: "browser",
    intent: "smoke",
    expected: "smoke",
    base_weight: 1,
    status: CheckStatus.PLANNED,
    weight: 1,
    actual: "",
    evidence: [],
    finding_ids: [],
    skip_reason: "",
    metadata: {},
  };
}

const playwrightAvailable = await canLaunchPlaywrightChromium();

describe("LEM-060 browser smoke leg (local demo-web fixture)", () => {
  it.skipIf(!playwrightAvailable)("serves demo-web locally and produces non-blocked browser.load with captured evidence", async () => {
    const srv = await serveDemoWeb();
    const temp = await mkdtemp(join(tmpdir(), "lemma-browser-smoke-"));
    const saved: Array<{ name: string; kind?: string }> = [];
    const outcomes = new Map<string, CheckOutcome>();
    try {
      const evidence = {
        saveJson: (name: string, _payload: unknown, kind?: string) => {
          saved.push(kind ? { name, kind } : { name });
          return `evidence/${name}.json`;
        },
        saveScreenshot: (name: string) => {
          saved.push({ name, kind: "screenshot" });
          return `evidence/${name}.png`;
        },
        saveBytes: (name: string, _data: Uint8Array | Buffer, kind?: string, _d?: string, _c?: string, suffix?: string) => {
          saved.push(kind ? { name, kind } : { name });
          return `evidence/${name}${suffix ?? ".bin"}`;
        },
      };

      await runBrowserChecks({
        url: srv.url,
        checks: [makeCheck("browser.load"), makeCheck("browser.console"), makeCheck("browser.network"), makeCheck("browser.content")],
        evidence,
        options: { headless: true },
        onOutcome: (check, outcome) => outcomes.set(check.id, outcome),
      });

      const load = outcomes.get("browser.load");
      expect(load, "browser.load outcome missing").toBeTruthy();
      expect(load?.status).not.toBe(CheckStatus.BLOCKED);
      expect([CheckStatus.PASSED, CheckStatus.FAILED, CheckStatus.SKIPPED]).toContain(load?.status);

      const hasScreenshotEvidence = saved.some((e) => e.kind === "screenshot" || e.name.includes("screenshot"));
      const hasConsoleEvidence = saved.some((e) => e.kind === "console" || e.name.includes("console"));
      const hasNetworkEvidence = saved.some((e) => e.kind === "network" || e.name.includes("network"));
      expect(hasScreenshotEvidence).toBe(true);
      expect(hasConsoleEvidence || hasNetworkEvidence).toBe(true);
    } finally {
      await srv.close();
      await rm(temp, { recursive: true, force: true });
    }
  }, 120000);
});
