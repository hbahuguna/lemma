import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const coreSrc = join(repoRoot, "packages/core/src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) out.push(full);
  }
  return out.sort();
}

const forbiddenImportPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "@lemma/agent", pattern: /from\s+["']@lemma\/agent(?:\/[^"']*)?["']|import\s*\(\s*["']@lemma\/agent/ },
  { label: "@lemma/cli", pattern: /from\s+["']@lemma\/cli(?:\/[^"']*)?["']|import\s*\(\s*["']@lemma\/cli/ },
  { label: "@lemma/browser", pattern: /from\s+["']@lemma\/browser(?:\/[^"']*)?["']|import\s*\(\s*["']@lemma\/browser/ },
  { label: "@lemma/cloud", pattern: /from\s+["']@lemma\/cloud(?:\/[^"']*)?["']|import\s*\(\s*["']@lemma\/cloud/ },
  { label: "@lemma/pro", pattern: /from\s+["']@lemma\/pro(?:\/[^"']*)?["']|import\s*\(\s*["']@lemma\/pro/ },
  { label: "@lemma/adapters-*", pattern: /from\s+["']@lemma\/adapters-[^"']*["']|import\s*\(\s*["']@lemma\/adapters-/ },
  // Host SDKs / optional runtimes must never leak into core.
  { label: "playwright", pattern: /from\s+["'](?:playwright|@playwright\/test|playwright-core)["']|import\s*\(\s*["'](?:playwright|@playwright\/test|playwright-core)/ },
  { label: "host-sdk", pattern: /from\s+["'](?:@opencode-ai\/|@anthropic-ai\/|@openai\/codex|@cursor\/)["']|import\s*\(\s*["'](?:@opencode-ai\/|@anthropic-ai\/|@openai\/codex|@cursor\/)/ },
];

describe("architecture dependency direction", () => {
  it("keeps @lemma/core source free of adapter/host/optional-package imports", () => {
    const files = listTsFiles(coreSrc);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const { label, pattern } of forbiddenImportPatterns) {
        if (pattern.test(text)) {
          violations.push(`${relative(repoRoot, file)} imports forbidden dependency: ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });


  it("keeps @lemma/pro source limited to @lemma/core and documented peers (no core/adapters/host leakage)", () => {
    const proSrc = join(repoRoot, "packages/pro/src");
    const files = listTsFiles(proSrc);
    expect(files.length).toBeGreaterThan(0);

    const allowed = [
      /^node:/,
      /^@lemma\/core(?:\/[^"']*)?$/,
      // documented optional peer for LEM-114/LEM-117 entitlement/auth contract reuse (no parallel auth)
      /^@lemma\/cloud(?:\/entitlements|\/signup|\/auth)?$/,
    ];
    const importRe = /(?:from\s+["']([^"']+)["'])|(?:import\s*\(\s*["']([^"']+)["']\s*\))/g;
    const violations: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(text)) !== null) {
        const spec = m[1] ?? m[2] ?? "";
        if (!spec) continue;
        if (spec.startsWith(".") || spec.startsWith("/")) continue; // relative/internal
        if (allowed.some((re) => re.test(spec))) continue;
        violations.push(`${relative(repoRoot, file)} imports non-allowed dependency: ${spec}`);
      }
    }

    expect(violations).toEqual([]);
  });

});
