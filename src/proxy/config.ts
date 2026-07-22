/**
 * @file Backend configuration parsing. A config is a non-empty JSON array
 * of `{cmd, args?}` objects; the first entry is the primary language
 * server and the rest are diagnostics sidecars.
 */

import { readFileSync } from "node:fs";

/** A backend's launch vector: `argv[0]` is the command, the rest its arguments. */
export interface BackendSpec {
  readonly argv: readonly string[];
}

/** Raised when the backend configuration is missing or not usable. */
export class ConfigurationError extends Error {}

export function parseBackendSpecs(value: unknown): BackendSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigurationError("configuration must be a non-empty array");
  }

  return value.map((entry, position) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigurationError(`backend ${position} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record)
      .filter((key) => key !== "cmd" && key !== "args")
      .sort();
    if (unknown.length > 0) {
      throw new ConfigurationError(
        `backend ${position} has unsupported fields: ${unknown.join(", ")}`,
      );
    }

    const command = record.cmd;
    if (typeof command !== "string" || command.length === 0) {
      throw new ConfigurationError(`backend ${position} requires a non-empty cmd`);
    }
    const args = record.args ?? [];
    if (!Array.isArray(args) || !args.every((argument) => typeof argument === "string")) {
      throw new ConfigurationError(`backend ${position} args must be an array of strings`);
    }
    return { argv: [command, ...(args as string[])] };
  });
}

export function readBackendSpecs(configPath: string): BackendSpec[] {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`cannot read ${configPath}: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`cannot read ${configPath}: ${detail}`);
  }
  return parseBackendSpecs(parsed);
}
