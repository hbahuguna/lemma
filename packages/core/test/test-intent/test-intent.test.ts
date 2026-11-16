import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateError, manageTests } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-test-intent-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function scenario(title = "Scenario", url = "https://example.test") {
  return {
    title,
    steps: [
      { step_number: 1, name: "Go", action: "goto", target: url, value: "", options: {}, raw_instruction: "Go" },
      { step_number: 2, name: "See body", action: "assert_visible", target: "body", value: "", options: {}, raw_instruction: "See body" },
    ],
    source: "explicit",
    model: "",
    target_url: url,
  };
}

function intent(id: string, reviewed = false, extra: any = {}) {
  return { id, title: `Title ${id}`, reviewed, scenario: scenario(`Scenario ${id}`), ...extra };
}

function formatInput(format: string, intents: any[]) {
  if (format === "lemma-native") return { schema_version: "lemma.test-intents/v1", intents };
  if (format === "xml") {
    const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<tests>\n${intents.map(i => `  <test id="${esc(i.id)}" title="${esc(i.title)}" reviewed="${i.reviewed ? "true" : "false"}"><scenario><![CDATA[${JSON.stringify(i.scenario)}]]></scenario></test>`).join("\n")}\n</tests>`;
  }
  if (format === "testrail") return { format: "testrail", cases: intents.map(i => ({ id: i.id, title: i.title, reviewed: i.reviewed, scenario: i.scenario })) };
  if (format === "xray") return { format: "xray", tests: intents.map(i => ({ id: i.id, title: i.title, reviewed: i.reviewed, scenario: i.scenario })) };
  if (format === "xlsx") return { format: "xlsx", sheet: "tests", rows: intents.map(i => ({ id: i.id, title: i.title, reviewed: i.reviewed, scenario: i.scenario })) };
  if (format === "docx") return { format: "docx", document: "tests", sections: intents.map(i => ({ id: i.id, title: i.title, reviewed: i.reviewed, scenario: i.scenario })) };
  throw new Error("bad format");
}

async function bakeIntents(root: string, suite: string, intents: any[]) {
  return manageTests({ action: "bake", suite, root, input: intents } as any);
}

describe("LEM-171 durable test-intent management", () => {
  it("create/list/delete actions work and delete refuses reviewed without --force", async () => {
    await withTempDir(async (root) => {
      await manageTests({ action: "create", suite: "s1", root, intent: intent("t1", false) } as any);
      const listed = await manageTests({ action: "list", root } as any);
      expect(listed.result.suites[0].suite).toBe("s1");
      expect(listed.result.suites[0].intents[0].id).toBe("t1");

      // mark reviewed by baking reviewed intent
      await bakeIntents(root, "s1", [intent("t1", true)]);
      await expect(manageTests({ action: "delete", suite: "s1", id: "t1", root } as any)).rejects.toBeInstanceOf(StateError);
      await expect(manageTests({ action: "delete", suite: "s1", id: "t1", root, force: true } as any)).resolves.toMatchObject({ ok: true });
    });
  });

  for (const format of ["lemma-native", "xml", "testrail", "xray", "xlsx", "docx"] as const) {
    it(`import/convert/bake support format=${format} and round-trip import→bake→export preserves stable ids and semantics`, async () => {
      await withTempDir(async (root) => {
        const src = [intent("A-1"), intent("B-2")];
        const input = formatInput(format, src);
        const imported = await manageTests({ action: "import", format, suite: "suite1", root, input } as any);
        expect(imported.ok).toBe(true);
        expect(imported.result.intents.map((i: any) => i.id).sort()).toEqual(["A-1", "B-2"]);

        // bake reproducible manifest
        const manifest = JSON.parse(await fs.readFile(path.join(root, ".lemma", "tests", "suite1", "manifest.json"), "utf8"));
        expect(manifest.schema_version).toBe("lemma.tests.manifest/v1");
        expect(manifest.intents.map((i: any) => i.id)).toEqual(["A-1", "B-2"]);

        // export (convert from baked intents) preserves stable ids/semantics
        const baked = manifest.intents;
        const exported = await manageTests({ action: "convert", format, root, input: baked, outputFormat: format } as any);
        const outText = exported.result.output as string;
        const reparsed = await manageTests({ action: "convert", format, root, input: outText, outputFormat: "lemma-native" } as any);
        const round = JSON.parse(reparsed.result.output).intents;
        expect(round.map((i: any) => [i.id, i.scenario.title])).toEqual(baked.map((i: any) => [i.id, i.scenario.title]));
      });
    });
  }

  it("invalid imports raise typed error and do not partially write; overflow/rejection recorded explicitly", async () => {
    await withTempDir(async (root) => {
      const bad = { schema_version: "lemma.test-intents/v1", intents: [{ id: "bad", title: "Bad", reviewed: false, scenario: { title: "x", steps: [], source: "explicit", model: "", target_url: "x" } }] };
      await expect(manageTests({ action: "import", format: "lemma-native", suite: "sbad", root, input: bad } as any)).rejects.toBeInstanceOf(StateError);
      await expect(fs.access(path.join(root, ".lemma", "tests", "sbad"))).rejects.toBeTruthy();

      const many = formatInput("lemma-native", [intent("1"), intent("2"), intent("3")]);
      const res = await manageTests({ action: "import", format: "lemma-native", suite: "sover", root, input: many, maxTests: 2 } as any);
      expect(res.result.intents).toHaveLength(2);
      expect(res.overflow).toHaveLength(1);
      expect(res.overflow![0].reason).toMatch(/overflow|not written/i);
    });
  });

  it("applies redaction to imported content (secrets not persisted raw)", async () => {
    await withTempDir(async (root) => {
      const secretIntent = intent("sec-1", false, { title: "token=sk-SECRET12345678901234567890" });
      secretIntent.scenario.steps[0].name = "Bearer abc.def.ghi.jwtpartlongenough";
      const input = formatInput("lemma-native", [secretIntent]);
      const res = await manageTests({ action: "import", format: "lemma-native", suite: "sred", root, input } as any);
      expect(res.redacted).toBe(true);
      const manifestRaw = await fs.readFile(path.join(root, ".lemma", "tests", "sred", "manifest.json"), "utf8");
      expect(manifestRaw).not.toContain("SECRET12345678901234567890");
    });
  });
});
