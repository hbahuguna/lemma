import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CheckStatus, type Check, type CheckOutcome } from "@lemma/core";
import {
  redactHarPayload,
  redactTraceBytes,
  redactTraceText,
  runBrowserChecks,
} from "../src/index.js";

const SECRET = "not-a-real-capture-secret-LEM057";
const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    try { rmSync(t, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function makeCheck(id = "browser.load", title = id): Check {
  return {
    id,
    title,
    domain: "functional",
    persona: "functional",
    kind: "browser",
    intent: "test",
    expected: "test",
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

function makeStoredZip(entries: Array<{ name: string; content: string }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = enc.encode(e.content);
    const crc = (() => {
      let c = 0xffffffff;
      for (let i = 0; i < data.length; i++) {
        let x = (c ^ data[i]!) & 0xff;
        for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
        c = (c >>> 8) ^ x;
      }
      return (c ^ 0xffffffff) >>> 0;
    })();
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    lh.set(name, 30);
    chunks.push(lh, data);

    const cd = new Uint8Array(46 + name.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, name.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += lh.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { chunks.push(c); cdSize += c.length; offset += c.length; }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  chunks.push(eocd);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

describe("LEM-057 capture redaction helpers", () => {
  it("redacts sensitive HAR headers/cookies/query params and URLs", () => {
    const har = {
      log: {
        entries: [
          {
            request: {
              url: `https://example.test/path?token=${SECRET}&ok=1`,
              headers: [
                { name: "Authorization", value: `Bearer ${SECRET}` },
                { name: "X-Api-Key", value: SECRET },
                { name: "Accept", value: "text/html" },
              ],
              cookies: [{ name: "session", value: SECRET }],
              queryString: [
                { name: "token", value: SECRET },
                { name: "ok", value: "1" },
              ],
            },
            response: {
              headers: [{ name: "Set-Cookie", value: `sid=${SECRET}` }],
              cookies: [{ name: "sid", value: SECRET }],
            },
          },
        ],
      },
    };
    const redacted = JSON.stringify(redactHarPayload(har));
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("https://example.test/path");
    expect(redacted).not.toContain("token=not-a-real-capture-secret-LEM057");
  });

  it("redacts trace text and stored zip text entries", async () => {
    const text = `Authorization: Bearer ${SECRET}\nset-cookie: sid=${SECRET}\npassword=${SECRET}`;
    const redactedText = redactTraceText(text);
    expect(redactedText).not.toContain(SECRET);
    expect(redactedText).toContain("[REDACTED]");

    const zip = makeStoredZip([
      { name: "trace.trace", content: `token ${SECRET} Authorization: Bearer ${SECRET}` },
      { name: "meta.json", content: `{"ok":true}` },
    ]);
    const out = await redactTraceBytes(zip);
    const outText = new TextDecoder().decode(out);
    expect(outText).not.toContain(SECRET);
    expect(outText).toContain("meta.json");
  });
});

describe("LEM-057 runtime capture/finalization", () => {
  it("captures and saves redacted HAR/trace/video artifacts when enabled and attaches refs", async () => {
    const captured = {
      json: [] as Array<{ name: string; payload: unknown; kind?: string }>,
      bytes: [] as Array<{ name: string; kind?: string; suffix?: string; text: string }>,
    };
    const outcomes = new Map<string, CheckOutcome>();
    const videoDir = mkdtempSync(join(tmpdir(), "lemma-video-src-"));
    temps.push(videoDir);
    const videoSrc = join(videoDir, "run.webm");
    writeFileSync(videoSrc, Buffer.from("fake-webm"));

    const fakePage = {
      on() {},
      off() {},
      goto: () => Promise.resolve({ status: () => 200, headers: () => Promise.resolve({}) }),
      url: () => "https://example.test/",
      evaluate: () => Promise.resolve({ title: "T", bodyTextLength: 100, h1s: ["H"], links: [] }),
      screenshot: () => Promise.resolve(Buffer.from("png")),
      video: () => ({ path: () => Promise.resolve(videoSrc) }),
    };

    const playwrightLoader = () =>
      Promise.resolve({
        chromium: {
          launch: () =>
            Promise.resolve({
              newContext: (opts?: Record<string, unknown>) => {
                const recordHar = opts?.recordHar as { path?: string } | undefined;
                const harPath = recordHar?.path ?? (opts as { record_har_path?: string } | undefined)?.record_har_path;
                const tracing = {
                  start: () => Promise.resolve(),
                  stop: ({ path }: { path: string }) => {
                    writeFileSync(
                      path,
                      Buffer.from(makeStoredZip([{ name: "t.txt", content: `Authorization: Bearer ${SECRET}` }])),
                    );
                    return Promise.resolve();
                  },
                };
                return Promise.resolve({
                  tracing,
                  newPage: () => Promise.resolve(fakePage),
                  close: () => {
                    if (typeof harPath === "string") {
                      writeFileSync(
                        harPath,
                        JSON.stringify({
                          log: {
                            entries: [
                              {
                                request: {
                                  url: `https://example.test/?token=${SECRET}`,
                                  headers: [{ name: "Authorization", value: SECRET }],
                                  cookies: [],
                                  queryString: [{ name: "token", value: SECRET }],
                                },
                              },
                            ],
                          },
                        }),
                        "utf8",
                      );
                    }
                    return Promise.resolve();
                  },
                });
              },
              close: () => Promise.resolve(),
            }),
        },
      });

    const evidence = {
      saveJson: (name: string, payload: unknown, kind?: string) => {
        captured.json.push(kind ? { name, payload, kind } : { name, payload });
        return `evidence/${name}.json`;
      },
      saveScreenshot: () => "evidence/shot.png",
      saveBytes: (name: string, data: Uint8Array | Buffer, kind?: string, _d?: string, _c?: string, suffix?: string) => {
        captured.bytes.push({
          name,
          text: Buffer.from(data).toString("utf8"),
          ...(kind ? { kind } : {}),
          ...(suffix ? { suffix } : {}),
        });
        return `evidence/${name}${suffix ?? ""}`;
      },
    };

    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load")],
      options: {
        captureHar: true,
        captureTrace: true,
        captureVideo: true,
        playwrightLoader,
      },
      evidence,
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });

    expect(outcomes.get("browser.load")?.status).toBe(CheckStatus.PASSED);
    expect(captured.json.some((j) => j.kind === "har")).toBe(true);
    expect(captured.bytes.some((b) => b.kind === "trace")).toBe(true);
    expect(captured.bytes.some((b) => b.kind === "video")).toBe(true);

    const harEntry = captured.json.find((j) => j.kind === "har");
    expect(JSON.stringify(harEntry?.payload)).not.toContain(SECRET);
    const traceEntry = captured.bytes.find((b) => b.kind === "trace");
    expect(traceEntry?.text).not.toContain(SECRET);

    const refs = outcomes.get("browser.load")?.evidence ?? [];
    expect(refs.some((r) => r.includes("har-log"))).toBe(true);
    expect(refs.some((r) => r.includes("playwright-trace"))).toBe(true);
    expect(refs.some((r) => r.includes("browser-video"))).toBe(true);
  });

  it("does not capture artifacts by default and does not crash on unavailable artifacts", async () => {
    const captured = {
      json: [] as Array<{ name: string; kind?: string }>,
      bytes: [] as Array<{ name: string; kind?: string }>,
    };
    const outcomes = new Map<string, CheckOutcome>();
    const fakePage = {
      on() {},
      off() {},
      goto: () => Promise.resolve({ status: () => 200, headers: () => Promise.resolve({}) }),
      url: () => "https://example.test/",
      evaluate: () => Promise.resolve({ title: "T", bodyTextLength: 100, h1s: ["H"], links: [] }),
      screenshot: () => Promise.resolve(Buffer.from("png")),
      video: () => ({ path: () => Promise.reject(new Error("no video")) }),
    };
    const playwrightLoader = () =>
      Promise.resolve({
        chromium: {
          launch: () =>
            Promise.resolve({
              newContext: () =>
                Promise.resolve({
                  tracing: { start: () => Promise.resolve(), stop: () => Promise.resolve() },
                  newPage: () => Promise.resolve(fakePage),
                  close: () => Promise.resolve(),
                }),
              close: () => Promise.resolve(),
            }),
        },
      });
    const evidence = {
      saveJson: (name: string, _payload: unknown, kind?: string) => {
        captured.json.push(kind ? { name, kind } : { name });
        return `evidence/${name}.json`;
      },
      saveBytes: (name: string, _d: Uint8Array | Buffer, kind?: string) => {
        captured.bytes.push(kind ? { name, kind } : { name });
        return `evidence/${name}`;
      },
    };

    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load")],
      options: { playwrightLoader },
      evidence,
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });

    expect(outcomes.get("browser.load")?.status).toBe(CheckStatus.PASSED);
    expect(captured.json.some((j) => j.kind === "har")).toBe(false);
    expect(captured.bytes.some((b) => b.kind === "trace" || b.kind === "video")).toBe(false);
  });
});
