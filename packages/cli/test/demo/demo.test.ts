import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/index.js";

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runCli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (c) => { stdout += c; },
    stderr: (c) => { stderr += c; },
  });
  return { code, stdout, stderr };
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).replaceAll(path.sep, "/");
      if (e.isDirectory()) await walk(abs);
      else out.push(rel);
    }
  }
  await walk(root);
  return out.sort();
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("LEM-153 lemma demo", () => {
  it("generates demo project with required markers, warnings, and intentional flaws", async () => {
    const root = await mkdtemp("lemma-demo-gen-");
    tempDirs.push(root);
    const target = path.join(root, "lemma-demo");

    const res = await runCli(["demo", "--target", target, "--seed", "7"]);
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout) as any;
    expect(json.command).toBe("demo");
    expect(json.test_only).toBe(true);
    expect(json.warning).toMatch(/test-only/i);

    const files = await listFilesRecursive(target);
    expect(files).toEqual([
      ".lemma-demo",
      "NOT-FOR-DEPLOYMENT",
      "README.md",
      "app.js",
      "index.html",
      "logo.png",
    ].sort());

    const readme = await fs.readFile(path.join(target, "README.md"), "utf8");
    expect(readme.split("\n")[0]).toMatch(/WARNING: THIS IS A TEST-ONLY DEMO\. DO NOT DEPLOY\./);
    const blocker = await fs.readFile(path.join(target, "NOT-FOR-DEPLOYMENT"), "utf8");
    expect(blocker).toMatch(/DO NOT DEPLOY/);
    const marker = JSON.parse(await fs.readFile(path.join(target, ".lemma-demo"), "utf8"));
    expect(marker.test_only).toBe(true);
    expect(marker.seed).toBe(7);

    const html = await fs.readFile(path.join(target, "index.html"), "utf8");
    expect(html).toMatch(/<img src="logo\.png">/); // missing alt text
    expect(html).toMatch(/href="broken\.html"/); // broken link

    const js = await fs.readFile(path.join(target, "app.js"), "utf8");
    expect(js).toMatch(/lemma_demo_fake_secret_7_NOT_REAL/); // exposed secret-shaped fake string
  });

  it("refuses to overwrite non-empty directory without --force and does not mutate existing files", async () => {
    const root = await mkdtemp("lemma-demo-refuse-");
    tempDirs.push(root);
    const target = path.join(root, "not-empty");
    await fs.mkdir(target, { recursive: true });
    const existingPath = path.join(target, "user.txt");
    await fs.writeFile(existingPath, "keep me", "utf8");

    const res = await runCli(["demo", "--target", target]);
    expect(res.code).not.toBe(0);
    const payload = JSON.parse(res.stdout) as any;
    expect(payload.ok).toBe(false);
    expect(String(payload.error?.message ?? "")).toMatch(/Refusing to generate demo/);

    expect(await fs.readFile(existingPath, "utf8")).toBe("keep me");
    const files = await listFilesRecursive(target);
    expect(files).toEqual(["user.txt"]);
  });

  it("regenerates deterministically and idempotently for existing demo-marker directory (same seed)", async () => {
    const root = await mkdtemp("lemma-demo-idem-");
    tempDirs.push(root);
    const target = path.join(root, "lemma-demo");

    const r1 = await runCli(["demo", "--target", target, "--seed", "42"]);
    expect(r1.code).toBe(0);
    const snap1 = await listFilesRecursive(target);
    const contents1 = Object.fromEntries(await Promise.all(snap1.map(async (f) => [f, await fs.readFile(path.join(target, f), "utf8")])));

    // re-run without --force into demo-marker dir should regenerate deterministically
    const r2 = await runCli(["demo", "--target", target, "--seed", "42"]);
    expect(r2.code).toBe(0);
    const json2 = JSON.parse(r2.stdout) as any;
    expect(json2.regenerated).toBe(true);
    const snap2 = await listFilesRecursive(target);
    const contents2 = Object.fromEntries(await Promise.all(snap2.map(async (f) => [f, await fs.readFile(path.join(target, f), "utf8")])));

    expect(snap2).toEqual(snap1);
    expect(contents2).toEqual(contents1);
  });

  it("never writes outside the target directory", async () => {
    const root = await mkdtemp("lemma-demo-sandbox-");
    tempDirs.push(root);
    const target = path.join(root, "safe", "lemma-demo");
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "outside", "utf8");

    const res = await runCli(["demo", "--target", target, "--seed", "1"]);
    expect(res.code).toBe(0);
    expect(await fs.readFile(outside, "utf8")).toBe("outside");
    const rootFiles = await fs.readdir(root);
    expect(rootFiles.sort()).toEqual(["outside.txt", "safe"].sort());
  });

  it("runs end-to-end via lemma run against generated demo with --no-browser (blocked-but-informative/static checks exercised)", async () => {
    const root = await mkdtemp("lemma-demo-e2e-");
    tempDirs.push(root);
    const target = path.join(root, "lemma-demo");

    const gen = await runCli(["demo", "--target", target, "--seed", "5"]);
    expect(gen.code).toBe(0);

    const run = await runCli(["run", "--target", target, "--no-browser"]);
    // report should be emitted on stdout (JSON) even if not fully passing; parseable and informative
    expect(run.stdout.trim().length).toBeGreaterThan(0);
    const report = JSON.parse(run.stdout) as any;
    expect(report).toBeTruthy();
    expect(report.status || report.decision || report.schema_version).toBeTruthy();
    // static checks should have executed/exercised; evidence of checks or findings/blockers present
    const hasChecks = Array.isArray(report.checks) || Array.isArray(report.results) || report.checks_run !== undefined || report.summary !== undefined;
    expect(hasChecks || Array.isArray(report.findings) || Array.isArray(report.blockers)).toBe(true);
  }, 30_000);
});
