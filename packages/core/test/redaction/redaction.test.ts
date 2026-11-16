import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  containsRedactionMarker,
  redactSecretValue,
  redactText,
  redactUnknown,
  sanitizeUrl,
} from "../../src/index.js";

type CorpusEntry = { id: string; value: string; category?: string };
type Corpus = { version: number; description?: string; entries: CorpusEntry[] };

const corpusPath = path.join(__dirname, "fixtures", "redaction-corpus.json");
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8")) as Corpus;

function assertNoLeak(message: string, leakedValue: string): void {
  // Failure messages must never print the original secret value.
  expect(message).not.toContain(leakedValue);
}

describe("LEM-008 redaction engine and synthetic corpus", () => {
  it("covers at least 25 synthetic credential shapes plus Jira and storage state cases", () => {
    expect(Array.isArray(corpus.entries)).toBe(true);
    expect(corpus.entries.length).toBeGreaterThanOrEqual(25);
    const categories = new Set(corpus.entries.map((e) => e.category ?? "credential"));
    expect(categories.has("jira")).toBe(true);
    expect(categories.has("storage_state")).toBe(true);

    for (const entry of corpus.entries) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.value).toBe("string");
      expect(entry.value.trim().length).toBeGreaterThan(0);

      const redacted = redactText(entry.value);
      if (redacted === entry.value) {
        // fail without printing the secret
        assertNoLeak(`corpus entry ${entry.id} was not redacted`, entry.value);
        throw new Error(`corpus entry ${entry.id} was not redacted`);
      }
      expect(redacted).not.toBe(entry.value);
      expect(redacted).not.toContain(entry.value);
      expect(containsRedactionMarker(redacted) || !redacted.includes(entry.value)).toBe(true);
    }
  });

  it("a deliberately broken redactor fails the corpus test without printing original values", () => {
    const broken = (value: string): string => value; // no-op
    const leakedIds: string[] = [];
    for (const entry of corpus.entries) {
      const out = broken(entry.value);
      if (out.includes(entry.value)) leakedIds.push(entry.id);
    }
    // broken redactor must leak (proves corpus test would fail)
    expect(leakedIds.length).toBeGreaterThan(0);

    // Simulate the failure message that a corpus test would emit.
    const failureMessage = `redaction corpus regression: ${leakedIds.length} value(s) leaked (ids: ${leakedIds.join(",")})`;
    for (const entry of corpus.entries) {
      assertNoLeak(failureMessage, entry.value);
    }
    expect(failureMessage).not.toMatch(/AKIA|ghp_|xoxb-|eyJ|Bearer |Basic |sessionid=|password\s*=|client_secret/i);
  });

  it("is idempotent and does not corrupt non-secret content", () => {
    const safeSamples = [
      "hello world",
      "path=/usr/local/bin",
      "count: 42",
      "https://example.com/docs?page=1&lang=en",
      "normal log line with no secrets and punctuation: ok.",
      JSON.stringify({ ok: true, items: [1, 2, 3], name: "sample" }),
    ];
    for (const sample of safeSamples) {
      const once = redactText(sample);
      const twice = redactText(once);
      expect(once).toBe(sample);
      expect(twice).toBe(once);
    }

    for (const entry of corpus.entries) {
      const once = redactText(entry.value);
      const twice = redactText(once);
      expect(twice).toBe(once);
      expect(once).not.toContain(entry.value);
    }
  });

  it("sanitizes URLs and redacts nested payloads for pre-persistence artifacts", () => {
    const url = "https://user:pass@example.com/cb?token=abc123&ok=1&sessionid=s3cr3t";
    const sanitized = sanitizeUrl(url);
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("s3cr3t");
    expect(sanitized).toContain("ok=1");
    expect(sanitized).not.toContain("user:pass@");

    const payload = {
      headers: {
        authorization: "Bearer not-a-real-bearer-token-1234567890",
        cookie: "sid=not-a-real-cookie",
      },
      nested: {
        token: "nested-token-value-should-hide",
        note: "safe",
      },
      url: "https://example.com/?api_key=leaky",
    };
    const redactedPayload = redactUnknown(payload);
    const serialized = JSON.stringify(redactedPayload);
    expect(serialized).not.toContain("not-a-real-bearer-token-1234567890");
    expect(serialized).not.toContain("not-a-real-cookie");
    expect(serialized).not.toContain("nested-token-value-should-hide");
    expect(serialized).not.toContain("leaky");
    expect(serialized).toContain("safe");

    expect(redactSecretValue("short")).toBe("[REDACTED]");
    expect(redactSecretValue("longsecretvalue")).toContain("[REDACTED");
  });

  it("artifact scan: corpus values do not reach serialized state/evidence/log/stdout/report outputs", () => {
    const values = corpus.entries.map((e) => e.value);
    const artifacts = {
      state: {
        progress: { note: values[0], check: "scan" },
        event: `token found: ${values[5]}`,
      },
      evidence: {
        manifest: { files: [{ path: "secrets.txt", snippet: values[10] }] },
        body: values[15],
      },
      log: [`stderr: ${values[20]}`, { detail: values[1] }],
      stdout: JSON.stringify({ ok: true, report: values[2] }),
      report: { summary: values[3], findings: [{ message: values[4] }] },
    };

    const redactedArtifacts = redactUnknown(artifacts);
    const serialized = JSON.stringify(redactedArtifacts, null, 2);

    const leaked: string[] = [];
    for (const value of values) {
      if (serialized.includes(value)) leaked.push(value);
    }
    // Evidence/scan output must not include original values.
    const scanReport = {
      corpus_entries: values.length,
      leaked_count: leaked.length,
      leaked_ids: corpus.entries.filter((e) => serialized.includes(e.value)).map((e) => e.id),
      redaction_markers_present: containsRedactionMarker(serialized),
    };
    // write scan output as evidence artifacts (not committed secret values)
    const runtimeOutDir = path.join(__dirname, "..", "..", "..", "..", ".lemma", "evidence", "LEM-008");
    fs.mkdirSync(runtimeOutDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeOutDir, "artifact-scan-output.json"), JSON.stringify(scanReport, null, 2));

    const committedOutDir = path.join(__dirname, "..", "..", "..", "..", "docs", "parity", "evidence");
    fs.mkdirSync(committedOutDir, { recursive: true });
    fs.writeFileSync(
      path.join(committedOutDir, "LEM-123-redaction-artifact-scan.json"),
      JSON.stringify(scanReport, null, 2) + "\n",
    );

    expect(scanReport.leaked_count).toBe(0);
    expect(scanReport.redaction_markers_present).toBe(true);
    // ensure failure would not print secrets (defensive)
    for (const value of values) {
      assertNoLeak(JSON.stringify(scanReport), value);
    }
  });
});
