import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOST_INSTALL_LAYOUTS,
  HOST_IDS,
  HOST_PACKAGING_SCHEMA_VERSION,
  OPERATIONAL_COMMAND_TEMPLATE_NAMES,
  SKILL_TEMPLATE_NAME,
  assertValidHostPackagingManifest,
  createHostPackagingManifest,
  getHostPackagingManifest,
  validateHostPackagingManifest,
} from "../src/index.js";

const catalogNames = Array.from({ length: 59 }, (_, i) => `assay-cmd-${i + 1}`);

describe("LEM-108 host packaging manifest contract", () => {
  it("creates deterministic manifests with expected layout and asset metadata", () => {
    for (const host of HOST_IDS) {
      const manifest = createHostPackagingManifest({
        host,
        packageName: `@lemma/adapters-${host}`,
        catalogCommandNames: catalogNames,
      });
      expect(manifest.schemaVersion).toBe(HOST_PACKAGING_SCHEMA_VERSION);
      expect(manifest.host).toBe(host);
      expect(manifest.packageName).toBe(`@lemma/adapters-${host}`);
      expect(manifest.layout).toEqual(DEFAULT_HOST_INSTALL_LAYOUTS[host]);
      expect(manifest.commands.catalogCount).toBe(59);
      expect(manifest.commands.catalogNames).toEqual(catalogNames);
      expect(manifest.commands.operationalNames).toEqual([...OPERATIONAL_COMMAND_TEMPLATE_NAMES]);
      expect(manifest.skill).toEqual({ name: SKILL_TEMPLATE_NAME, path: manifest.layout.skillPath });
      expect(validateHostPackagingManifest(manifest, { catalogCount: 59, catalogNames }).ok).toBe(true);
      expect(() => assertValidHostPackagingManifest(manifest, { catalogCount: 59 })).not.toThrow();
      expect(getHostPackagingManifest(host, manifest.packageName, catalogNames)).toEqual(manifest);
    }

    expect(DEFAULT_HOST_INSTALL_LAYOUTS.opencode).toEqual({
      commandsDir: ".opencode/commands",
      skillPath: ".opencode/skills/lemma/SKILL.md",
    });
    expect(OPERATIONAL_COMMAND_TEMPLATE_NAMES).toEqual([
      "assay",
      "assay-status",
      "assay-report",
      "assay-abort",
      "assay-verify-evidence",
    ]);
  });

  it("rejects invalid or inconsistent manifests", () => {
    const valid = createHostPackagingManifest({
      host: "cursor",
      packageName: "@lemma/adapters-cursor",
      catalogCommandNames: catalogNames,
    });
    expect(validateHostPackagingManifest(null).ok).toBe(false);
    expect(validateHostPackagingManifest({ ...valid, schemaVersion: 999 }).ok).toBe(false);
    expect(validateHostPackagingManifest({ ...valid, host: "nope" }).errors.join(" ")).toContain("host must be one of");
    expect(
      validateHostPackagingManifest({
        ...valid,
        layout: { commandsDir: "/abs/commands", skillPath: valid.layout.skillPath },
      }).errors.join(" "),
    ).toContain("project-relative");
    expect(
      validateHostPackagingManifest({
        ...valid,
        commands: { ...valid.commands, catalogCount: 58 },
      }).errors.join(" "),
    ).toContain("catalogCount must equal");
    expect(
      validateHostPackagingManifest(valid, { catalogCount: 58 }).errors.join(" "),
    ).toContain("commands.catalogCount must be 58");
    expect(() => assertValidHostPackagingManifest({ ...valid, packageName: "" })).toThrow(/Invalid host packaging manifest/);
  });
});
