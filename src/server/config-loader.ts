/**
 * @file Per-workspace config discovery. Reads
 * `safer-architecture.config.json` at the workspace root and validates
 * it through the same schema the programmatic API uses. An invalid file
 * NEVER silently degrades to defaults without a signal: the loader
 * reports the problem so the server can surface a diagnostic on the
 * config file itself.
 */

import fs from "node:fs";
import path from "node:path";
import { type ArchitectureOptionsInput, resolveArchitectureOptions } from "../analyzer/project/api/index.js";

/** Name looked for at the workspace root, and the file a config problem is reported against. */
export const CONFIG_FILE_NAME = "safer-architecture.config.json";

/**
 * Outcome of one config lookup: the options to analyze with, where they
 * came from, and the problem to surface when the file was present but
 * unusable.
 */
export interface LoadedWorkspaceConfig {
  /** Raw options to pass to the registry (empty when defaults apply). */
  readonly options: ArchitectureOptionsInput;
  /** Where the options came from. */
  readonly source: "file" | "defaults";
  /** Absolute path the loader looked at, whether or not it existed. */
  readonly configPath: string;
  /**
   * Set when the file exists but could not be used (unreadable, bad
   * JSON, schema-invalid). The server publishes this on the config file
   * as an error diagnostic; analysis proceeds with defaults.
   */
  readonly problem: string | null;
}

/**
 * Read the workspace config file, if any, and check it against the
 * options schema. An absent file resolves to defaults quietly; a present
 * but unreadable, malformed, or schema-invalid one also resolves to
 * defaults but carries the reason, so a typo cannot quietly relax rules.
 * @param projectRoot Workspace root the config file is looked up under.
 * @returns Options for the registry, their origin, and any problem found.
 */
export function loadWorkspaceConfig(projectRoot: string): LoadedWorkspaceConfig {
  const configPath = path.join(projectRoot, CONFIG_FILE_NAME);
  if (!fs.existsSync(configPath)) {
    return { options: {}, source: "defaults", configPath, problem: null };
  }

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return {
      options: {},
      source: "defaults",
      configPath,
      problem: `config file exists but could not be read: ${describe(error)}`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      options: {},
      source: "defaults",
      configPath,
      problem: `config file is not valid JSON: ${describe(error)}`,
    };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      options: {},
      source: "defaults",
      configPath,
      problem: "config file must contain a JSON object of architecture options",
    };
  }

  const candidate =
    // `raw` is a plain JSON object here, and the schema check below rejects
    // it before the options ever reach the registry, so the cast is safe.
    raw as ArchitectureOptionsInput;
  try {
    // Validation only — the registry resolves again with projectRoot.
    resolveArchitectureOptions({ ...candidate, projectRoot });
  } catch (error) {
    return {
      options: {},
      source: "defaults",
      configPath,
      problem: describe(error),
    };
  }

  return { options: candidate, source: "file", configPath, problem: null };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
