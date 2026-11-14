import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface WorkspacePackage {
  readonly dir: string;
  readonly name: string;
}

const workspacePackages: readonly WorkspacePackage[] = [
  { dir: "packages/core", name: "@lemma/core" },
  { dir: "packages/agent", name: "@lemma/agent" },
  { dir: "packages/browser", name: "@lemma/browser" },
  { dir: "packages/cli", name: "@lemma/cli" },
  { dir: "packages/cloud", name: "@lemma/cloud" },
  { dir: "packages/personas", name: "@lemma/personas" },
  { dir: "packages/adapters/opencode", name: "@lemma/adapters-opencode" },
  { dir: "packages/adapters/claude-code", name: "@lemma/adapters-claude-code" },
  { dir: "packages/adapters/codex", name: "@lemma/adapters-codex" },
  { dir: "packages/adapters/antigravity", name: "@lemma/adapters-antigravity" },
  { dir: "packages/adapters/cursor", name: "@lemma/adapters-cursor" },
];

interface PackageManifest {
  readonly name: string;
  readonly type: string;
  readonly exports: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
}

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8");

const readManifest = (dir: string): PackageManifest =>
  JSON.parse(readRepoFile(`${dir}/package.json`)) as PackageManifest;

describe("workspace skeleton", () => {
  it("exposes the core package name", () => {
    expect(PACKAGE_NAME).toBe("@lemma/core");
  });

  it.each(workspacePackages)("ships a buildable shell for $name", ({ dir, name }) => {
    const manifest = readManifest(dir);

    expect(manifest.name).toBe(name);
    expect(manifest.type).toBe("module");
    expect(manifest.exports["."]).toMatchObject({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(readRepoFile(`${dir}/tsconfig.json`)).toContain("tsconfig.base.json");
    expect(readRepoFile(`${dir}/src/index.ts`)).toContain(name);
  });

  it("keeps @lemma/core free of workspace dependencies", () => {
    const core = readManifest("packages/core");
    const workspaceDeps = Object.entries(core.dependencies ?? {}).filter(([, version]) =>
      version.startsWith("workspace:"),
    );

    expect(workspaceDeps).toEqual([]);
  });

  it("keeps the dependency direction one-way", () => {
    const allowedDependencies: Record<string, readonly string[]> = {
      "@lemma/core": [],
      "@lemma/agent": ["@lemma/core"],
      "@lemma/browser": ["@lemma/core"],
      "@lemma/cloud": ["@lemma/core"],
      "@lemma/personas": ["@lemma/core"],
      "@lemma/cli": ["@lemma/agent", "@lemma/core"],
      "@lemma/adapters-opencode": ["@lemma/agent"],
      "@lemma/adapters-claude-code": ["@lemma/agent"],
      "@lemma/adapters-codex": ["@lemma/agent"],
      "@lemma/adapters-antigravity": ["@lemma/agent"],
      "@lemma/adapters-cursor": ["@lemma/agent"],
    };

    for (const { dir, name } of workspacePackages) {
      const manifest = readManifest(dir);
      const workspaceDeps = Object.entries(manifest.dependencies ?? {})
        .filter(([, version]) => version.startsWith("workspace:"))
        .map(([dependency]) => dependency)
        .sort();

      expect(workspaceDeps, `${name} workspace dependencies`).toEqual(
        [...(allowedDependencies[name] ?? [])].sort(),
      );
    }
  });
});
