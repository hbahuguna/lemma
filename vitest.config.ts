import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@lemma/core", replacement: fromRoot("./packages/core/src/index.ts") },
      { find: "@lemma/agent", replacement: fromRoot("./packages/agent/src/index.ts") },
      { find: "@lemma/browser", replacement: fromRoot("./packages/browser/src/index.ts") },
      { find: "@lemma/cli", replacement: fromRoot("./packages/cli/src/index.ts") },
      { find: "@lemma/cloud", replacement: fromRoot("./packages/cloud/src/index.ts") },
      { find: "@lemma/personas", replacement: fromRoot("./packages/personas/src/index.ts") },
      {
        find: "@lemma/adapters-opencode",
        replacement: fromRoot("./packages/adapters/opencode/src/index.ts"),
      },
      {
        find: "@lemma/adapters-claude-code",
        replacement: fromRoot("./packages/adapters/claude-code/src/index.ts"),
      },
      {
        find: "@lemma/adapters-codex",
        replacement: fromRoot("./packages/adapters/codex/src/index.ts"),
      },
      {
        find: "@lemma/adapters-antigravity",
        replacement: fromRoot("./packages/adapters/antigravity/src/index.ts"),
      },
      {
        find: "@lemma/adapters-cursor",
        replacement: fromRoot("./packages/adapters/cursor/src/index.ts"),
      },
      {
        find: "@lemma/adapters-sdk",
        replacement: fromRoot("./packages/adapters/sdk/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
