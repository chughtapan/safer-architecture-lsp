/**
 * @file Package-exports flattening. Walks the `package.json` exports
 * tree (subpath maps + conditional maps) into a flat list of
 * public-path / target-path pairs the architecture rules consume.
 */

import type { PackageExportEntry, PackageJson } from "../diagnostics/index.js";

/**
 * Flatten a `package.json` into the list of public path / target path
 * entries it exposes. Reads `exports` when present and falls back to
 * `main` / `types` otherwise.
 * @param packageJson Parsed `package.json` contents.
 * @returns Public-path-to-target-path entries; empty when no exports
 * are declared.
 */
export function collectPackageExportEntries(
  packageJson: PackageJson,
): readonly PackageExportEntry[] {
  if (packageJson.exports !== undefined) {
    return collectExportsValue(packageJson.exports, ".");
  }

  const entries: PackageExportEntry[] = [];
  if (packageJson.main) entries.push({ publicPath: ".", targetPath: packageJson.main });
  if (packageJson.types) entries.push({ publicPath: ".", targetPath: packageJson.types });
  return entries;
}

/**
 * Recursively walk a node-exports value (string, array, or conditional
 * map) and emit one entry per target path. Subpath maps (`"./foo": ...`)
 * descend into their values; condition maps (`"import": ...`,
 * `"types": ...`) flatten through.
 * @param value Raw value at this position in the exports tree.
 * @param publicPath The public path key accumulated from parent
 * subpath entries (root call typically passes `"."`).
 * @returns Flattened public-path-to-target-path entries.
 */
export function collectExportsValue(
  value: unknown,
  publicPath: string,
): readonly PackageExportEntry[] {
  if (typeof value === "string") return [{ publicPath, targetPath: value }];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectExportsValue(item, publicPath));
  }
  if (value === null || typeof value !== "object") return [];

  const entries = Object.entries(value);
  const hasSubpathKeys = entries.some(([key]) => key === "." || key.startsWith("./"));

  if (hasSubpathKeys) {
    return entries.flatMap(([key, nestedValue]) =>
      key === "." || key.startsWith("./") ? collectExportsValue(nestedValue, key) : [],
    );
  }

  return entries.flatMap(([, nestedValue]) => collectExportsValue(nestedValue, publicPath));
}
