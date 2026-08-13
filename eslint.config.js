/**
 * @file Type-aware lint policy. Agent Code Guard's `recommended` preset is
 * applied per scope so each scope gets the TypeScript program that actually
 * contains its files: src via the project service, tests via a dedicated
 * tsconfig that includes them, and root config files via the default project.
 */

import globals from "globals";
import { plugin as guard } from "eslint-plugin-agent-code-guard";

const recommended = guard.configs.recommended;

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".repos/**",
      ".claude/**",
      "**/*.d.ts",
      "tests/fixtures/**",
    ],
  },
  {
    ...recommended,
    files: ["src/**/*.ts"],
  },
  {
    ...recommended,
    files: ["tests/**/*.ts"],
    languageOptions: {
      ...recommended.languageOptions,
      parserOptions: {
        projectService: false,
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ...recommended,
    files: ["*.ts"],
    languageOptions: {
      ...recommended.languageOptions,
      parserOptions: {
        projectService: false,
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The agent-code-guard preset is type-aware and scoped to .ts, so plain
    // JavaScript in the repo would otherwise be visited and never checked.
    // scripts/coverage-gate.mjs gates CI, so it gets an explicit floor.
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      // The full Node global set, not a hand-picked pair: no-undef is an error
      // here, so a missing global fails lint on correct code.
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": "error",
      "no-undef": "error",
      "no-const-assign": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "eqeqeq": ["error", "always"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Vitest's config contract is a default export, so the rule that bans them
    // is scoped off here rather than reshaping application modules around a
    // tool convention.
    rules: { "import-x/no-default-export": "off" },
    files: ["vitest.config.ts", "eslint.config.js"],
  },
];
