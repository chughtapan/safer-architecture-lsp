/**
 * @file Manifest reading. Narrows a project's `package.json` down to the
 * fields the architecture rules consult, and supplies an empty stand-in so
 * a project without a manifest still analyzes instead of failing.
 */

import fs from "node:fs";
import path from "node:path";
import type { PackageJson } from "./diagnostics/index.js";
import { collectExportsValue } from "./package-exports/index.js";

interface JsonObject {
  readonly [key: string]: unknown;
}

/**
 * Read a project's manifest and keep only the name, entrypoint, dependency,
 * and subpath fields the architecture rules reason about. Null signals that
 * there is nothing to read, which callers turn into an empty manifest.
 * @param projectRoot Directory the `package.json` is looked for in.
 * @returns The narrowed manifest, or null when the file is absent or does
 * not hold a JSON object.
 */
export function readPackageJson(projectRoot: string): PackageJson | null {
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {return null;}

  const parsed =
    // `JSON.parse` is typed `any`; widening its result to `unknown` is safe
    // because every field below is read through a validating accessor.
    JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
  if (!isJsonObject(parsed)) {return null;}

  return {
    name: readString(parsed.name),
    main: readString(parsed.main),
    types: readString(parsed.types),
    exports: parsed.exports,
    imports: readImportsMap(parsed.imports),
    dependencies: readStringMap(parsed.dependencies),
    devDependencies: readStringMap(parsed.devDependencies),
    peerDependencies: readStringMap(parsed.peerDependencies),
  };
}

/**
 * Stand in for a project with no readable manifest, so passes can iterate
 * the dependency and subpath maps without first testing for their absence.
 * @returns A manifest whose maps are empty and whose entrypoints are unset.
 */
export function emptyPackageJson(): PackageJson {
  return {
    imports: new Map(),
    dependencies: new Map(),
    devDependencies: new Map(),
    peerDependencies: new Map(),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringMap(value: unknown): ReadonlyMap<string, string> {
  if (!isJsonObject(value)) {return new Map();}

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return new Map(entries);
}

/**
 * Parse the Node subpath-imports (`imports`) field into each `#` key's
 * flat list of leaf target strings, descending through condition maps
 * and arrays. Non-`#` keys are ignored (Node rejects them).
 * @param value Raw `imports` field, of whatever shape the manifest gave it.
 * @returns Each `#` key paired with its leaf targets; keys that resolve to
 * no target are dropped.
 */
function readImportsMap(value: unknown): ReadonlyMap<string, readonly string[]> {
  if (!isJsonObject(value)) {return new Map();}

  const entries: Array<[string, readonly string[]]> = [];
  for (const [key, target] of Object.entries(value)) {
    if (!key.startsWith("#")) {continue;}
    const leaves = collectExportsValue(target, key).map((entry) => entry.targetPath);
    if (leaves.length > 0) {entries.push([key, leaves]);}
  }
  return new Map(entries);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
