import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { discoverFeatures } from "../../src/index.js";

async function withFixture(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-features-"));
  try {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "src", "App.tsx"),
      [
        "export function App() {",
        '  return <main><Route path="/dashboard" element={<Dashboard/>} />',
        '    <button data-testid="save-btn">Save changes</button>',
        '    <input aria-label="Search" placeholder="Search" />',
        '    <select name="region"><option>EU</option></select>',
        '    <button role="switch" aria-label="Dark mode" />',
        '    <form aria-label="Profile form"></form>',
        "  </main>;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(dir, "src", "routes.ts"), 'router.get("/api/health", handler);\n', "utf8");
    await mkdir(path.join(dir, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "ignored", "x.ts"), '<button>Ignored</button>', "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("source feature discovery", () => {
  it("finds routes, buttons, inputs, selects, toggles and forms with source provenance", async () => {
    await withFixture(async (dir) => {
      const inventory = discoverFeatures(dir);
      expect(inventory.schema_version).toBe("lemma.feature_inventory/v1");
      expect(inventory.files_scanned).toBe(2);
      const kinds = new Set(inventory.features.map((f) => f.kind));
      for (const kind of ["route", "button", "input", "select", "toggle", "form"]) {
        expect(kinds.has(kind as never)).toBe(true);
      }
      const save = inventory.features.find((f) => f.label === "Save changes");
      expect(save?.selector_hint).toBe('[data-testid="save-btn"]');
      expect(save?.source.path).toBe("src/App.tsx");
      expect(save?.source.line).toBeGreaterThan(0);
      expect(inventory.features.some((f) => f.label === "/dashboard")).toBe(true);
      expect(inventory.features.some((f) => f.label === "Ignored")).toBe(false);
    });
  });

  it("is deterministic for the same tree", async () => {
    await withFixture(async (dir) => {
      const a = discoverFeatures(dir);
      const b = discoverFeatures(dir);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const ids = a.features.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
