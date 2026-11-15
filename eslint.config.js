import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.changeset/**",
      "**/.lemma/**",
      "**/.harness/**",
      "examples/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs,ts}", "**/vitest.config.ts", "scripts/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  prettier,
);
