import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  EvidenceStore,
  SourceInspector,
  StaticCheckRunner,
} from "../../src/index.js";

type CorpusExpect = {
  status?: string;
  anyFindingLocationIncludes?: string[];
  noFindingLocationIncludes?: string[];
  anyFindingTitleIncludes?: string[];
  minMatches?: number;
  minIgnoredPlaceholderOrTestFixtureMatches?: number;
  sourceFilesInclude?: string[];
  sourceFilesExclude?: string[];
};

type CorpusCase = {
  id: string;
  check: string;
  description: string;
  files: Record<string, string>;
  expect: CorpusExpect;
};

type Corpus = {
  version: number;
  description: string;
  cases: CorpusCase[];
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-pr-corpus-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFixtureFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

function locations(findings: Array<{ location?: unknown }>): string[] {
  return findings.map((f) => (typeof f.location === "string" ? f.location : ""));
}

function titles(findings: Array<{ title?: unknown }>): string[] {
  return findings.map((f) => (typeof f.title === "string" ? f.title : ""));
}

describe("LEM-039 static precision and recall corpus", () => {
  it("executes labeled corpus cases with deterministic expected outcomes", async () => {
    const corpusPath = path.join(import.meta.dirname, "corpus.json");
    const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as Corpus;
    expect(corpus.version).toBe(1);
    expect(Array.isArray(corpus.cases)).toBe(true);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(5);

    for (const c of corpus.cases) {
      await withTempDir(async (root) => {
        await writeFixtureFiles(root, c.files);
        const inventory = new SourceInspector(root).discover();

        if (c.check === "inventory-scope") {
          const sourceFiles = inventory.source_files;
          for (const needle of c.expect.sourceFilesInclude ?? []) {
            expect(sourceFiles, `${c.id}: expected source file ${needle}`).toContain(needle);
          }
          for (const needle of c.expect.sourceFilesExclude ?? []) {
            expect(sourceFiles, `${c.id}: unexpected source file ${needle}`).not.toContain(needle);
          }
          return;
        }

        const evidence = new EvidenceStore(root, `run-${c.id}`);
        const runner = new StaticCheckRunner(root, inventory, evidence);
        const outcome = await runner.run({ id: c.check });

        if (c.expect.status) {
          expect(outcome.status, `${c.id}: status`).toBe(c.expect.status);
        }

        const locs = locations(outcome.findings);
        const tts = titles(outcome.findings);

        for (const needle of c.expect.anyFindingLocationIncludes ?? []) {
          expect(
            locs.some((l) => l.includes(needle)),
            `${c.id}: expected finding location including ${needle}, got ${JSON.stringify(locs)}`,
          ).toBe(true);
        }
        for (const needle of c.expect.noFindingLocationIncludes ?? []) {
          expect(
            locs.some((l) => l.includes(needle)),
            `${c.id}: unexpected finding location including ${needle}, got ${JSON.stringify(locs)}`,
          ).toBe(false);
        }
        for (const needle of c.expect.anyFindingTitleIncludes ?? []) {
          expect(
            tts.some((t) => t.includes(needle)),
            `${c.id}: expected finding title including ${needle}, got ${JSON.stringify(tts)}`,
          ).toBe(true);
        }

        if (typeof c.expect.minMatches === "number") {
          expect(Number(outcome.metadata.matches ?? 0), `${c.id}: matches`).toBeGreaterThanOrEqual(
            c.expect.minMatches,
          );
        }
        if (typeof c.expect.minIgnoredPlaceholderOrTestFixtureMatches === "number") {
          expect(
            Number(outcome.metadata.ignored_placeholder_or_test_fixture_matches ?? 0),
            `${c.id}: ignored_placeholder_or_test_fixture_matches`,
          ).toBeGreaterThanOrEqual(c.expect.minIgnoredPlaceholderOrTestFixtureMatches);
        }

        // evidence linkage sanity for static checks
        expect(outcome.evidence.length, `${c.id}: evidence`).toBeGreaterThan(0);
      });
    }
  });
});
