import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckStatus,
  EvidenceStore,
  Severity,
  SourceInspector,
  StaticCheckRunner,
  Strength,
} from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-secret-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function touch(file: string, content = "") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

async function readEvidenceJson(root: string, relPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, relPath), "utf8")) as Record<string, unknown>;
}

describe("LEM-031 secret scanning and precision rules", () => {
  it("passes with redacted evidence payload when no credential-like values are found", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.ts"), 'export const msg = "hello";\n');

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-secret-clean");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.secrets" });

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect(outcome.findings).toEqual([]);
      expect(outcome.actual).toBe("No credential-like values found in scanned source.");
      expect(outcome.metadata).toEqual({
        matches: 0,
        ignored_placeholder_or_test_fixture_matches: 0,
      });
      expect(outcome.evidence[0]).toMatch(/secret-scan\.json$/);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect(payload.matches).toEqual([]);
      expect(payload.ignored_placeholder_or_test_fixture_matches).toBe(0);
      expect(payload.note).toBe("Values are redacted; length and prefix only.");

      const entries = evidence.getEntries();
      expect(entries[0]?.kind).toBe("static_analysis");
      expect(entries[0]?.description).toBe("Redacted secret scan results.");
      expect(entries[0]?.check_id).toBe("static.secrets");
    });
  });

  it("reports real-looking secrets with redaction and grouped findings", async () => {
    await withTempDir(async (root) => {
      await touch(
        path.join(root, "src", "config.py"),
        'api_key = "9f8a7b6c5d4e3f2a1b0c"\npassword = "S3cr3tV@lu3-Real"\n',
      );

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-secret-hit");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.secrets" });

      expect(outcome.status).toBe(CheckStatus.FAILED);
      expect(outcome.actual).toBe(
        `${(outcome.metadata as { matches: number }).matches} credential-like match(es) found; values are redacted in evidence.`,
      );
      expect((outcome.metadata as { matches: number }).matches).toBeGreaterThanOrEqual(2);
      expect(outcome.findings.length).toBe(1); // same rule+file grouped

      const f = outcome.findings[0]!;
      expect(f.title).toContain("Credential-like value hard-coded in source");
      expect(f.title).toContain("matches in src/config.py");
      expect(f.severity).toBe(Severity.HIGH);
      expect(f.domain).toBe("security");
      expect(f.strength).toBe(Strength.SOURCE_PROVEN);
      expect(f.location).toBe("src/config.py:1");
      expect(f.reproduction).toBe(
        "Inspect the redacted match in the evidence file and confirm whether the value is live.",
      );
      expect(f.tags).toEqual(["secret", "redacted"]);
      expect(f.evidence).toEqual(outcome.evidence);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      const matches = payload.matches as Array<Record<string, unknown>>;
      expect(matches.length).toBe((outcome.metadata as { matches: number }).matches);
      for (const m of matches) {
        expect(m.rule).toBe("generic-credential");
        expect(String(m.excerpt)).toMatch(/\[REDACTED/);
        expect(String(m.excerpt)).not.toContain("9f8a7b6c5d4e3f2a1b0c");
        expect(String(m.excerpt)).not.toContain("S3cr3tV@lu3-Real");
      }
    });
  });

  it("ignores placeholders and obvious synthetic test credentials while counting ignored fixtures", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "app.py"), "print('ok')\n");
      await touch(path.join(root, "src", "example.py"), 'api_key = "change_me_placeholder"\n');
      await touch(
        path.join(root, "tests", "test_billing.py"),
        [
          "secret = 'sk_test_dummy'",
          "api_key = 'whsec_test_secret'",
          "token = 'test-key'",
          "api_key = 'llm-openai-test'",
          "",
        ].join("\n"),
      );

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-secret-precision");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.secrets" });

      expect(outcome.status).toBe(CheckStatus.PASSED);
      expect((outcome.metadata as { matches: number }).matches).toBe(0);
      // 1 placeholder in src/example.py + 4 synthetic fixtures in test path
      expect(
        (outcome.metadata as { ignored_placeholder_or_test_fixture_matches: number })
          .ignored_placeholder_or_test_fixture_matches,
      ).toBeGreaterThanOrEqual(5);

      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      expect((payload.matches as unknown[]).length).toBe(0);
      expect((payload.ignored_placeholder_or_test_fixture_matches as number)).toBeGreaterThanOrEqual(5);
    });
  });

  it("redacts private key headers, downgrades severity in test paths, and preserves rule metadata", async () => {
    await withTempDir(async (root) => {
      await touch(
        path.join(root, "tests", "fixtures", "key.ts"),
        "export const pem = `-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----`;\n",
      );

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-secret-pk");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.secrets" });

      expect(outcome.status).toBe(CheckStatus.FAILED);
      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      const matches = payload.matches as Array<{ rule: string; severity: string; excerpt: string; file: string }>;
      expect(matches.length).toBe(1);
      expect(matches[0]!.rule).toBe("private-key");
      expect(matches[0]!.excerpt).toBe("[REDACTED PRIVATE KEY HEADER]");
      // CRITICAL downgraded once in test path -> HIGH
      expect(matches[0]!.severity).toBe(Severity.HIGH);
      expect(matches[0]!.file).toBe("tests/fixtures/key.ts");

      const f = outcome.findings[0]!;
      expect(f.title).toContain("Private key material committed to the repository");
      expect(f.title).toContain("(1 match in tests/fixtures/key.ts)");
      expect(f.severity).toBe(Severity.HIGH);
      expect(f.tags).toEqual(["secret", "redacted"]);
    });
  });

  it("detects provider tokens with redacted excerpts", async () => {
    await withTempDir(async (root) => {
      await touch(path.join(root, "src", "secrets.ts"), 'export const k = "ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd";\n');

      const inventory = new SourceInspector(root).discover();
      const evidence = new EvidenceStore(root, "run-secret-gh");
      const runner = new StaticCheckRunner(root, inventory, evidence);
      const outcome = await runner.run({ id: "static.secrets" });

      expect(outcome.status).toBe(CheckStatus.FAILED);
      const payload = await readEvidenceJson(root, outcome.evidence[0]!);
      const matches = payload.matches as Array<{ rule: string; excerpt: string }>;
      expect(matches[0]!.rule).toBe("github-token");
      expect(matches[0]!.excerpt).toMatch(/\[REDACTED/);
      expect(matches[0]!.excerpt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd");
      expect(outcome.findings[0]!.tags).toEqual(["secret", "redacted"]);
    });
  });
});
