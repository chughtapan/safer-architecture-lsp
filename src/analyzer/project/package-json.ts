import fs from "node:fs";
import path from "node:path";
import type { PackageJson } from "./diagnostics/index.js";
import { collectExportsValue } from "./package-exports/index.js";

interface JsonObject {
  readonly [key: string]: unknown;
}

export function readPackageJson(projectRoot: string): PackageJson | null {
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;

  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
  if (!isJsonObject(parsed)) return null;

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

export function emptyPackageJson(): PackageJson {
  return {
    imports: new Map(),
    dependencies: new Map(),
    devDependencies: new Map(),
    peerDependencies: new Map(),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringMap(value: unknown): ReadonlyMap<string, string> {
  if (!isJsonObject(value)) return new Map();

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return new Map(entries);
}

/**
 * Parse the Node subpath-imports (`imports`) field into each `#` key's
 * flat list of leaf target strings, descending through condition maps
 * and arrays. Non-`#` keys are ignored (Node rejects them).
 */
function readImportsMap(value: unknown): ReadonlyMap<string, readonly string[]> {
  if (!isJsonObject(value)) return new Map();

  const entries: [string, readonly string[]][] = [];
  for (const [key, target] of Object.entries(value)) {
    if (!key.startsWith("#")) continue;
    const leaves = collectExportsValue(target, key).map((entry) => entry.targetPath);
    if (leaves.length > 0) entries.push([key, leaves]);
  }
  return new Map(entries);
}
