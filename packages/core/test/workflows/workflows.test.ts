import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MalformedWorkflowError,
  PHASE_ORDER,
  RELEASE_CONFIDENCE,
  WorkflowError,
  loadWorkflowFile,
  loadWorkflows,
} from "../../src/index.js";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

const VALID_WORKFLOW_YAML = `id: release-confidence
name: Release Confidence
version: "1.0"
description: Default
phases:
  - name: risk_analysis
    title: Risk Analysis
    description: Inspect
  - name: test_planning
    title: Test Planning
    description: Plan
  - name: execution
    title: Execution
    description: Run
  - name: evidence_collection
    title: Evidence Collection
    description: Collect
  - name: confidence_scoring
    title: Confidence Scoring
    description: Score
`;

describe("LEM-012 workflows loader and phase invariant", () => {
  it("built-in release-confidence workflow defines canonical five phases in fixed order", () => {
    expect(RELEASE_CONFIDENCE.id).toBe("release-confidence");
    expect(RELEASE_CONFIDENCE.name).toBe("Release Confidence");
    expect(RELEASE_CONFIDENCE.version).toBe("1.0");
    expect(RELEASE_CONFIDENCE.phases.map((p) => p.name)).toEqual([...PHASE_ORDER]);
    expect(PHASE_ORDER).toEqual([
      "risk_analysis",
      "test_planning",
      "execution",
      "evidence_collection",
      "confidence_scoring",
    ]);
    for (const phase of RELEASE_CONFIDENCE.phases) {
      expect(phase.title.length).toBeGreaterThan(0);
      expect(typeof phase.description).toBe("string");
    }
  });

  it("loads valid workflow file and directory (.yaml/.yml), returns empty for missing directory", async () => {
    const dir = await makeTempDir("lemma-wf-");
    const file = path.join(dir, "release.yaml");
    await fsp.writeFile(file, VALID_WORKFLOW_YAML, "utf8");
    const wf = loadWorkflowFile(file);
    expect(wf.id).toBe("release-confidence");
    expect(wf.phases.map((p) => p.name)).toEqual([...PHASE_ORDER]);
    expect(wf.version).toBe("1.0");

    const dir2 = await makeTempDir("lemma-wfdir-");
    await fsp.writeFile(path.join(dir2, "a.yaml"), VALID_WORKFLOW_YAML, "utf8");
    const alt = VALID_WORKFLOW_YAML.replace("id: release-confidence", "id: alt-flow").replace(
      "name: Release Confidence",
      "name: Alt Flow",
    );
    await fsp.writeFile(path.join(dir2, "b.yml"), alt, "utf8");
    const loaded = loadWorkflows(dir2);
    expect(Object.keys(loaded).sort()).toEqual(["alt-flow", "release-confidence"]);

    expect(loadWorkflows(path.join(dir2, "missing"))).toEqual({});
    expect(loadWorkflows(null)).toEqual({});
  });

  it("rejects malformed/unsupported YAML and IO/parse failures with typed workflow errors", async () => {
    const dir = await makeTempDir("lemma-wf-bad-");
    const badCases: Array<[string, RegExp | string]> = [
      ["", /empty/i],
      ["\tkey: value\n", /tabs/i],
      ["id: x\nphases:\n  - name: a\n    nested: {bad: 1}\n", /unsupported/i],
      ["id: x\nname: n\nversion: 1\nphases:\n  - &anchor name: risk_analysis\n", /unsupported/i],
      ['id: "unterminated\n', /unterminated/i],
      ["id: x\nid: y\nname: n\nversion: 1\nphases: []\n", /duplicate key/i],
      ["id: x\nname: n\nversion: 1\nphases:\n  - just-a-scalar\n    nested: oops\n", /scalar list item cannot contain/i],
    ];
    for (let i = 0; i < badCases.length; i++) {
      const entry = badCases[i];
      if (!entry) continue;
      const [content, pattern] = entry;
      const file = path.join(dir, `bad-${i}.yaml`);
      await fsp.writeFile(file, content, "utf8");
      const err = (() => {
        try {
          loadWorkflowFile(file);
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(err).toBeDefined();
      expect(err instanceof MalformedWorkflowError || err instanceof WorkflowError).toBe(true);
      expect(String((err as Error).message)).toMatch(pattern);
    }

    expect(() => loadWorkflowFile(path.join(dir, "nope.yaml"))).toThrow(WorkflowError);
  });

  it("enforces workflow validation and fixed phase invariant/order", async () => {
    const dir = await makeTempDir("lemma-wf-val-");
    const write = async (name: string, content: string) => {
      const file = path.join(dir, name);
      await fsp.writeFile(file, content, "utf8");
      return file;
    };

    const cases: Array<[string, string]> = [
      ["unknown-top.yaml", VALID_WORKFLOW_YAML + "extra: nope\n"],
      ["bad-id.yaml", VALID_WORKFLOW_YAML.replace("id: release-confidence", "id: Bad_ID")],
      ["missing-name.yaml", VALID_WORKFLOW_YAML.replace("name: Release Confidence\n", "")],
      ["bad-version.yaml", VALID_WORKFLOW_YAML.replace('version: "1.0"', "version: null")],
      ["wrong-count.yaml", VALID_WORKFLOW_YAML.replace("  - name: confidence_scoring\n    title: Confidence Scoring\n    description: Score\n", "")],
      [
        "wrong-order.yaml",
        VALID_WORKFLOW_YAML.replace(
          "  - name: risk_analysis\n    title: Risk Analysis\n    description: Inspect\n  - name: test_planning\n    title: Test Planning\n    description: Plan\n",
          "  - name: test_planning\n    title: Test Planning\n    description: Plan\n  - name: risk_analysis\n    title: Risk Analysis\n    description: Inspect\n",
        ),
      ],
      [
        "unknown-phase.yaml",
        VALID_WORKFLOW_YAML.replace("  - name: execution\n    title: Execution\n    description: Run\n", "  - name: mystery\n    title: Mystery\n    description: Nope\n"),
      ],
      [
        "unknown-phase-key.yaml",
        VALID_WORKFLOW_YAML.replace("    description: Inspect\n", "    description: Inspect\n    extra: nope\n"),
      ],
    ];

    for (const [name, content] of cases) {
      const file = await write(name, content);
      expect(() => loadWorkflowFile(file)).toThrow(WorkflowError);
    }

    // duplicate ids in directory rejected
    const dupDir = await makeTempDir("lemma-wf-dup-");
    await fsp.writeFile(path.join(dupDir, "a.yaml"), VALID_WORKFLOW_YAML, "utf8");
    await fsp.writeFile(path.join(dupDir, "b.yaml"), VALID_WORKFLOW_YAML, "utf8");
    expect(() => loadWorkflows(dupDir)).toThrow(WorkflowError);

    // non-directory path errors
    const notDir = path.join(dupDir, "file.txt");
    await fsp.writeFile(notDir, "hi", "utf8");
    expect(() => loadWorkflows(notDir)).toThrow(WorkflowError);
  });

  it("exports public APIs and uses shared typed errors", () => {
    expect(typeof loadWorkflowFile).toBe("function");
    expect(typeof loadWorkflows).toBe("function");
    expect(RELEASE_CONFIDENCE).toBeDefined();
    try {
      loadWorkflowFile("/definitely/not/here/workflow.yaml");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as Error).name).toBe("WorkflowError");
    }
  });
});
