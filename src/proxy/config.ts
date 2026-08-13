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

/**
 * Validate decoded JSON into launch vectors. Unknown per-backend fields are
 * rejected rather than ignored, so a misspelled key fails loudly instead of
 * silently launching a backend without the option its author intended.
 * @param value Untrusted decoded JSON; anything but a non-empty array of
 * `{cmd, args?}` objects is a `ConfigurationError`.
 * @returns One spec per entry, in config order, so index 0 stays the primary.
 */
export function parseBackendSpecs(value: unknown): BackendSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigurationError("configuration must be a non-empty array");
  }

  return value.map((entry: unknown, position: number) => {
    if (!isRecord(entry)) {
      throw new ConfigurationError(`backend ${position} must be an object`);
    }
    const record = entry;
    const unknown = Object.keys(record)
      .filter((key) => key !== "cmd" && key !== "args")
      .sort(compareStrings);
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
    return { argv: [command, ...(args)] };
  });
}

/**
 * Load and validate the config file. An unreadable file and unparsable JSON are
 * reported the same way — as a `ConfigurationError` naming the path — so the
 * CLI can exit with a usage code instead of a stack trace.
 * @param configPath File to read; it is quoted back in every failure message.
 * @returns One spec per configured backend, primary first.
 */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Reproduces the default `Array.prototype.sort` order for strings, so the
// field names reported in a message stay in the same order on every host.
function compareStrings(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}
