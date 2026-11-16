import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const cloudPkgDir = join(testDir, "..");
const repoRoot = join(cloudPkgDir, "../..");

function readJson(p: string): any {
  return JSON.parse(readFileSync(p, "utf8"));
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out.sort();
}

describe("LEM-122 cloud package boundaries and optional extras", () => {
  it("declares root and granular optional extra subpath exports with safe metadata", () => {
    const manifest = readJson(join(cloudPkgDir, "package.json"));
    expect(manifest.sideEffects).toBe(false);
    const expected = [
      ".",
      "./metering",
      "./auth",
      "./quota",
      "./ledger",
      "./signup",
      "./billing",
      "./queue",
      "./retention",
      "./entitlements",
      "./package.json",
    ];
    for (const key of expected) {
      expect(manifest.exports[key], `missing export ${key}`).toBeTruthy();
    }
    for (const sub of ["metering", "auth", "quota", "ledger", "signup", "billing", "queue", "retention", "entitlements"]) {
      expect(manifest.exports[`./${sub}`]).toMatchObject({
        types: `./dist/${sub}.d.ts`,
        import: `./dist/${sub}.js`,
      });
    }
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@lemma/core"]);
  });

  it("keeps cloud isolated: no workspace package depends on @lemma/cloud and no non-cloud source imports it", () => {
    const workspacePackages = [
      "packages/core/package.json",
      "packages/agent/package.json",
      "packages/browser/package.json",
      "packages/cli/package.json",
      "packages/personas/package.json",
      "packages/adapters/opencode/package.json",
      "packages/adapters/claude-code/package.json",
      "packages/adapters/codex/package.json",
      "packages/adapters/antigravity/package.json",
      "packages/adapters/cursor/package.json",
      "packages/cloud/package.json",
    ];
    for (const rel of workspacePackages) {
      const manifest = readJson(join(repoRoot, rel));
      const deps = {
        ...(manifest.dependencies ?? {}),
        ...(manifest.peerDependencies ?? {}),
        ...(manifest.optionalDependencies ?? {}),
      };
      if (rel === "packages/cloud/package.json") {
        expect(deps["@lemma/cloud"]).toBeUndefined();
      } else if (rel === "packages/core/package.json") {
        // core may declare cloud only as an optional peer (contract/subpath integration)
        if (deps["@lemma/cloud"]) {
          expect(manifest.peerDependencies?.["@lemma/cloud"]).toBeTruthy();
          expect(manifest.peerDependenciesMeta?.["@lemma/cloud"]?.optional).toBe(true);
        }
      } else {
        expect(deps["@lemma/cloud"], `${rel} must not depend on @lemma/cloud`).toBeUndefined();
      }
    }

    const sourceDirs = [
      "packages/core/src",
      "packages/agent/src",
      "packages/browser/src",
      "packages/cli/src",
      "packages/personas/src",
      "packages/adapters/opencode/src",
      "packages/adapters/claude-code/src",
      "packages/adapters/codex/src",
      "packages/adapters/antigravity/src",
      "packages/adapters/cursor/src",
    ];
    const pattern = /from\s+["']@lemma\/cloud(?:\/[^"']*)?["']|import\s*\(\s*["']@lemma\/cloud/;
    const violations: string[] = [];
    for (const dir of sourceDirs) {
      for (const file of listSourceFiles(join(repoRoot, dir))) {
        const text = readFileSync(file, "utf8");
        if (pattern.test(text)) violations.push(relative(repoRoot, file));
      }
    }
    expect(violations).toEqual([]);
  });
});
