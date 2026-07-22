import fs from "node:fs";
import path from "node:path";
import type { PackageJson } from "./diagnostics/index.js";

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
    dependencies: readStringMap(parsed.dependencies),
    devDependencies: readStringMap(parsed.devDependencies),
    peerDependencies: readStringMap(parsed.peerDependencies),
  };
}

export function emptyPackageJson(): PackageJson {
  return {
    dependencies: new Map(),
    devDependencies: new Map(),
    peerDependencies: new Map(),
  };
}

export function isJsonObject(value: unknown): value is JsonObject {
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
