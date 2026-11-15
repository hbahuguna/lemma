import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CheckStatus, type Check, type CheckOutcome } from "@lemma/core";
import {
  BrowserUnavailableError,
  resolveBrowserStorageState,
  runBrowserChecks,
} from "../src/index.js";

const SECRET = "not-a-real-session-secret-LEM056";

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

function validState() {
  return {
    cookies: [
      {
        name: "session",
        value: SECRET,
        domain: "example.test",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  delete process.env.LEMMA_AUTH_STATE_TEST;
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("LEM-056 storage state resolution", () => {
  it("resolves valid state from file and env:VAR", () => {
    const dir = mkdtempSync(join(tmpdir(), "lemma-storage-"));
    tempDirs.push(dir);
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify(validState()), "utf8");

    const fromFile = resolveBrowserStorageState(file);
    expect(fromFile.cookies).toHaveLength(1);

    process.env.LEMMA_AUTH_STATE_TEST = JSON.stringify(validState());
    const fromEnv = resolveBrowserStorageState("env:LEMMA_AUTH_STATE_TEST");
    expect(fromEnv.origins).toEqual([]);
  });

  it("rejects missing env/file and invalid JSON/object/arrays", () => {
    expect(() => resolveBrowserStorageState("env:LEMMA_AUTH_STATE_TEST_MISSING")).toThrowError(
      BrowserUnavailableError,
    );
    expect(() => resolveBrowserStorageState("env:LEMMA_AUTH_STATE_TEST_MISSING")).toThrow(
      "Storage state environment variable 'LEMMA_AUTH_STATE_TEST_MISSING' is not set.",
    );

    expect(() => resolveBrowserStorageState("/tmp/lemma-missing-storage-state-LEM056.json")).toThrow(
      "Storage state file was not found:",
    );

    const dir = mkdtempSync(join(tmpdir(), "lemma-storage-"));
    tempDirs.push(dir);
    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{not json", "utf8");
    expect(() => resolveBrowserStorageState(badJson)).toThrow("Storage state is not valid JSON.");

    const notObj = join(dir, "arr.json");
    writeFileSync(notObj, JSON.stringify([1, 2, 3]), "utf8");
    expect(() => resolveBrowserStorageState(notObj)).toThrow("Storage state must be a JSON object.");

    const badArrays = join(dir, "bad-arrays.json");
    writeFileSync(badArrays, JSON.stringify({ cookies: {}, origins: [] }), "utf8");
    expect(() => resolveBrowserStorageState(badArrays)).toThrow(
      "Storage state cookies and origins must be arrays.",
    );

    const badCookie = join(dir, "bad-cookie.json");
    writeFileSync(badCookie, JSON.stringify({ cookies: ["x"], origins: [] }), "utf8");
    expect(() => resolveBrowserStorageState(badCookie)).toThrow(
      "Storage state contains an invalid cookie entry.",
    );
  });

  it("rejects expired and empty storage state", () => {
    const expired = {
      cookies: [
        {
          name: "session",
          value: SECRET,
          domain: "example.test",
          path: "/",
          expires: 1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    };
    expect(() => resolveBrowserStorageState(expired)).toThrow(
      "Storage state has expired; provide a fresh state file or secret.",
    );

    expect(() => resolveBrowserStorageState({ cookies: [], origins: [] })).toThrow(
      "Storage state is empty.",
    );
  });
});

describe("LEM-056 runtime injection and blocked degradation", () => {
  it("injects resolved storage state into Playwright context without leaking secrets into outcomes", async () => {
    const state = validState();
    const contextOptionsSeen: Array<Record<string, unknown>> = [];
    const outcomes = new Map<string, CheckOutcome>();

    const fakePage = () => {
      const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
      return {
        on(event: string, cb: (...args: unknown[]) => void) {
          (handlers[event] ??= []).push(cb);
        },
        off() {},
        goto() {
          return Promise.resolve({
            status: () => 200,
            headers: () => Promise.resolve({}),
          });
        },
        url() {
          return "https://example.test/protected";
        },
        evaluate() {
          return Promise.resolve({
            title: "Protected page",
            bodyTextLength: 120,
            h1s: ["Protected page"],
            links: [],
          });
        },
      };
    };

    const playwrightLoader = () =>
      Promise.resolve({
        chromium: {
          launch: () =>
            Promise.resolve({
              newContext: (opts?: Record<string, unknown>) => {
                contextOptionsSeen.push(opts ?? {});
                return Promise.resolve({
                  newPage: () => Promise.resolve(fakePage()),
                  close: () => Promise.resolve(),
                });
              },
              close: () => Promise.resolve(),
            }),
        },
      });

    await runBrowserChecks({
      url: "https://example.test/protected",
      checks: [makeCheck("browser.load", "Page load")],
      options: { storageState: state, playwrightLoader },
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });

    expect(contextOptionsSeen).toHaveLength(1);
    const injected = contextOptionsSeen[0]?.storageState as { cookies?: unknown[] } | undefined;
    expect(injected).toBeTruthy();
    expect(Array.isArray(injected?.cookies)).toBe(true);

    const outcome = outcomes.get("browser.load");
    expect(outcome?.status).toBe(CheckStatus.PASSED);
    const serialized = JSON.stringify({
      status: outcome?.status,
      actual: outcome?.actual,
      metadata: outcome?.metadata,
      findings: outcome?.findings,
      evidence: outcome?.evidence,
      blocker: outcome?.blocker,
    });
    expect(serialized).not.toContain(SECRET);
  });

  it("degrades all browser checks to blocked outcomes when storage state is missing", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load"), makeCheck("browser.console")],
      options: {
        storageState: "/tmp/lemma-missing-storage-state-LEM056.json",
        playwrightLoader: () =>
          Promise.resolve({
            chromium: {
              launch: () =>
                Promise.resolve({
                  newContext: () =>
                    Promise.resolve({
                      newPage: () => Promise.resolve({}),
                      close: () => Promise.resolve(),
                    }),
                  close: () => Promise.resolve(),
                }),
            },
          }),
      },
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });

    expect(outcomes.get("browser.load")?.status).toBe(CheckStatus.BLOCKED);
    expect(outcomes.get("browser.console")?.status).toBe(CheckStatus.BLOCKED);
    expect(outcomes.get("browser.load")?.actual).toContain("Storage state file was not found");
    expect(String(outcomes.get("browser.load")?.blocker?.boundary)).toContain(
      "Storage state file was not found",
    );
  });

  it("does not apply storage-state resolution when injected page views are provided", async () => {
    const outcomes = new Map<string, CheckOutcome>();
    await runBrowserChecks({
      url: "https://example.test/",
      checks: [makeCheck("browser.load")],
      options: {
        storageState: "/tmp/lemma-missing-storage-state-LEM056.json",
        playwrightLoader: () => Promise.resolve({ chromium: { launch: () => Promise.resolve({}) } }),
      },
      pageView: {
        navigation: { url: "https://example.test/", finalUrl: "https://example.test/", status: 200 },
        snapshot: { title: "Injected", bodyTextLength: 100, h1s: ["Injected"] },
        consoleMessages: [],
        pageErrors: [],
        networkEntries: [],
        evidenceRefs: {},
      },
      onOutcome: (c, o) => outcomes.set(c.id, o),
    });
    expect(outcomes.get("browser.load")?.status).toBe(CheckStatus.PASSED);
  });
});
