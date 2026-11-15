/**
 * Example signed check plugin for lemma.
 *
 * Export `PLUGIN` from this module (or from the installed package entry point).
 * The signature is left empty in the repository; sign it with a key from
 * `.lemma/plugins/trusted_keys.json` before installing/trusting it. See README.md.
 */

import {
  CheckOutcome,
  CheckStatus,
  definePlugin,
  type PluginContext,
} from "@lemma/core";

export const DEFINITION = {
  id: "example.package_metadata",
  title: "The project declares package metadata",
  domain: "data_integrity",
  kind: "plugin" as const,
  intent: "Confirm the release has a machine-readable package identity.",
  expected: "At least one package manifest is present in the source inventory.",
  base_weight: 0.6,
  requires: "manifest" as const,
};

function manifestsFromInventory(inventory: unknown): string[] {
  if (inventory && typeof inventory === "object" && !Array.isArray(inventory)) {
    const raw = (inventory as { manifests?: unknown }).manifests;
    if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  }
  return [];
}

export async function evaluate(context: PluginContext): Promise<CheckOutcome> {
  const manifests = manifestsFromInventory(context.inventory);
  const evidence = await context.saveJson(
    "example-package-metadata",
    { manifests },
    "Package manifests observed by the example plugin.",
    "plugin",
  );
  return new CheckOutcome({
    status: manifests.length > 0 ? CheckStatus.PASSED : CheckStatus.FAILED,
    actual: `${manifests.length} package manifest(s) declared.`,
    evidence: [evidence],
    findings: [],
    blocker: null,
    metadata: { manifests },
  });
}

export const PLUGIN = definePlugin({
  definition: DEFINITION,
  evaluate,
  signature: "",
});

export default PLUGIN;
