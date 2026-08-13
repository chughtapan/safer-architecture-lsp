/**
 * @file Type-aware lint policy. Agent Code Guard's `recommended` preset is
 * applied per scope so each scope gets the TypeScript program that actually
 * contains its files: src via the project service, tests via a dedicated
 * tsconfig that includes them, and root config files via the default project.
 */

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
];
