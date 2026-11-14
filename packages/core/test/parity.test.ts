import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface ManifestEntry {
  source: string;
  kind: string;
  owner_tasks: string[];
  status: string;
}

interface Manifest {
  entries: ManifestEntry[];
}

function read(p: string): string {
  return readFileSync(join(repoRoot, p), "utf8");
}

function loadManifest(): Manifest {
  return JSON.parse(read("docs/parity/assay.manifest.json")) as Manifest;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

describe("parity manifest", () => {
  it("passes parity:check", () => {
    const res = spawnSync(process.execPath, ["scripts/parity/check.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("coverage summary by asset kind");
  });

  it("contains every asset enumerated in the markdown inventory", () => {
    const manifest = loadManifest();
    const inventory = read("docs/parity/assay-feature-inventory.md");
    const keys = new Set(manifest.entries.map((e) => `${e.kind}::${e.source}`));

    // 1. Core modules table: `harness/*.py` and `harness/py.typed`
    for (const m of inventory.matchAll(/^\|\s*`(harness\/[^`]+)`\s*\|/gm)) {
      expect(keys.has(`module::${m[1]}`), `module ${m[1]}`).toBe(true);
    }

    // 2. CLI commands table: `lemma <cmd>` -> cli:<cmd>
    for (const m of inventory.matchAll(/^\|\s*`lemma ([^`]+)`\s*\|/gm)) {
      const cmd = m[1].trim();
      expect(keys.has(`cli_command::cli:${cmd}`), `cli ${cmd}`).toBe(true);
    }

    // 3. Plugin module assets table
    for (const m of inventory.matchAll(/^\|\s*`(\.opencode\/[^`]+)`\s*\|/gm)) {
      const src = m[1];
      if (src.includes("*")) continue;
      const kind = src.endsWith(".md") ? "plugin_command" : "plugin_module";
      expect(keys.has(`${kind}::${src}`), `${kind} ${src}`).toBe(true);
    }
    // backup command pack wildcard => every backup md file present
    const backupCount = manifest.entries.filter(
      (e) => e.kind === "plugin_command" && e.source.startsWith(".opencode/commands/_assay_backup/"),
    ).length;
    expect(backupCount).toBeGreaterThanOrEqual(59);
    expect(keys.has("plugin_command::.opencode/commands/assay-browser.md")).toBe(true);
    expect(keys.has("plugin_command::plugin:/assay")).toBe(true);

    // 4. Personas/checks section
    for (const p of ["personas/functional.md", "personas/security.md", "personas/accessibility.md", "personas/README.md"]) {
      expect(keys.has(`persona::${p}`), p).toBe(true);
    }
    for (const m of inventory.matchAll(/`((?:browser|static)\.[a-z0-9_]+)`/g)) {
      expect(keys.has(`check_id::check:${m[1]}`), `check ${m[1]}`).toBe(true);
    }
    expect(manifest.entries.filter((e) => e.kind === "check_id").length).toBe(24);

    // 5. Schemas table
    for (const m of inventory.matchAll(/^\|\s*`(schemas\/[^`]+)`\s*\|/gm)) {
      expect(keys.has(`schema::${m[1]}`), `schema ${m[1]}`).toBe(true);
    }

    // 6. Fixtures/examples/release assets table
    for (const m of inventory.matchAll(/^\|\s*`([^`]+)`\s*\|[^|]*\|[^|]*LEM-/gm)) {
      const src = m[1];
      if (src.startsWith("harness/") || src.startsWith(".opencode/") || src.startsWith("schemas/") || src.startsWith("personas/")) continue;
      if (src.startsWith("tests/")) continue;
      if (src.startsWith("lemma ") || src.startsWith("cli:") || src.includes("*")) continue;
      // classify
      if (src === "Dockerfile" || src === "Dockerfile.browser" || src === "pyproject.toml" || src === "requirements.txt" || src.startsWith(".github/")) {
        const has =
          keys.has(`release_asset::${src}`) ||
          manifest.entries.some(
            (e) => e.kind === "release_asset" && e.source.startsWith(src.replace(/\/$/, "") + "/"),
          );
        expect(has, `release ${src}`).toBe(true);
      } else if (src.startsWith("examples/") || src.startsWith("calibration/") || src.startsWith("policies/")) {
        // directory assets in inventory map to their contained files in manifest
        const has = manifest.entries.some((e) => e.kind === "fixture" && (e.source === src || e.source.startsWith(src.replace(/\/$/, "") + "/")));
        expect(has, `fixture ${src}`).toBe(true);
      }
    }

    // 7. Test-suite mapping table (python tests and plugin tests)
    for (const m of inventory.matchAll(/^\|\s*`(test_[^`]+\.py)`\s*\|/gm)) {
      expect(keys.has(`test_file::tests/${m[1]}`), `test tests/${m[1]}`).toBe(true);
    }
    for (const m of inventory.matchAll(/^\|\s*`(tests\/plugin\/[^`]+)`\s*\|/gm)) {
      const src = m[1];
      if (src.includes("*")) {
        const has = manifest.entries.some((e) => e.kind === "test_file" && e.source.startsWith("tests/plugin/"));
        expect(has, `test ${src}`).toBe(true);
      } else {
        expect(keys.has(`test_file::${src}`), `test ${src}`).toBe(true);
      }
    }

    // every manifest entry must have a valid owner and known kind
    const kinds = new Set(manifest.entries.map((e) => e.kind));
    expect([...kinds].sort()).toEqual([
      "check_id",
      "cli_command",
      "fixture",
      "module",
      "persona",
      "plugin_command",
      "plugin_module",
      "release_asset",
      "schema",
      "test_file",
    ]);
    expect(uniq(manifest.entries.map((e) => `${e.kind}::${e.source}`)).length).toBe(manifest.entries.length);
  });

  it("fails when an owner task is removed from the manifest", () => {
    const manifest = loadManifest();
    const broken = JSON.parse(JSON.stringify(manifest)) as Manifest;
    expect(broken.entries.length).toBeGreaterThan(0);
    broken.entries[0]!.owner_tasks = [];

    const tmp = join(repoRoot, "docs/parity/.tmp-bad-manifest.json");
    writeFileSync(tmp, JSON.stringify(broken, null, 2));
    try {
      const res = spawnSync(
        process.execPath,
        ["scripts/parity/check.mjs", "--manifest", "docs/parity/.tmp-bad-manifest.json"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(res.status).not.toBe(0);
      expect(`${res.stdout}\n${res.stderr}`).toMatch(/missing owner task|FAIL/);
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
