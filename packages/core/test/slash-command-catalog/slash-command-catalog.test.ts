import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("LEM-154 slash-command catalog schema", () => {
  it("ships versioned slash command catalog with required commands and structure", async () => {
    const candidates = [
      path.resolve(process.cwd(), "schemas/agent/slash-commands.v1.json"),
      path.resolve(process.cwd(), "../../schemas/agent/slash-commands.v1.json"),
    ];
    let raw = "";
    let found = false;
    for (const p of candidates) {
      try {
        raw = await fs.readFile(p, "utf8");
        found = true;
        break;
      } catch {
        // try next
      }
    }
    expect(found).toBe(true);
    const catalog = JSON.parse(raw) as any;
    expect(catalog.schema_version).toBe("lemma.agent.slash_commands/v1");
    expect(Array.isArray(catalog.commands)).toBe(true);
    const names = catalog.commands.map((c: any) => c.command);
    for (const cmd of [
      "/lemma",
      "/lemma-test",
      "/lemma-issues",
      "/lemma-accessibility",
      "/lemma-map",
      "/lemma-help",
      "/lemma-settings",
      "/jay",
      "/full",
      "/lemma-background",
      "/lemma-pro",
    ]) {
      expect(names).toContain(cmd);
    }
    for (const c of catalog.commands) {
      expect(["manager", "catalog", "dashboard"]).toContain(c.target);
      expect(typeof c.description).toBe("string");
      expect(typeof c.intent).toBe("string");
      expect(Array.isArray(c.arguments)).toBe(true);
      expect(Array.isArray(c.errors)).toBe(true);
    }
  });
});
