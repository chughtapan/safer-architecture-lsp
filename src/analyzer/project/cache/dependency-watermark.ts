/**
 * @file Dependency watermark inputs for the architecture cache. Source
 * files are watermarked in disk-cache.ts directly; this module covers
 * the non-source inputs the analyzer reads (consumer's package.json,
 * tsconfig content, and the analyzer's own version), so edits to any
 * of them invalidate the persisted report.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ResolvedArchitectureOptions } from "../diagnostics/index.js";

const ANALYZER_VERSION_PSEUDO_PATH = "__analyzer_version__";
const PACKAGE_JSON_PSEUDO_PATH_SUFFIX = "/__package_json__";
const TSCONFIG_PSEUDO_PATH_SUFFIX = "/__tsconfig__";

export interface DependencyWatermark {
  readonly path: string;
  readonly hash: string;
}

/**
 * Watermark entries for analyzer inputs that aren't TypeScript source
 * files. Edits to any of these change the report even when no `.ts`
 * file changed, so they must participate in the cache watermark.
 * @param options Resolved architecture options (used for projectRoot
 * + tsconfig path).
 * @param findTsconfig Optional override for tsconfig lookup; defaults
 * to a tsconfig.json sibling of the project root.
 * @returns Pseudo-watermark entries for package.json, tsconfig, and
 * analyzer version.
 */
export function dependencyWatermarks(
  options: ResolvedArchitectureOptions,
  findTsconfig: (root: string) => string | undefined = (root) =>
    path.join(root, "tsconfig.json"),
): readonly DependencyWatermark[] {
  const root = path.resolve(options.projectRoot);
  const tsconfigPath = options.tsconfigPath ?? findTsconfig(root) ?? path.join(root, "tsconfig.json");
  return [
    { path: ANALYZER_VERSION_PSEUDO_PATH, hash: getAnalyzerVersion() },
    {
      path: `${root}${PACKAGE_JSON_PSEUDO_PATH_SUFFIX}`,
      hash: hashFileOrAbsent(path.join(root, "package.json")),
    },
    {
      path: `${root}${TSCONFIG_PSEUDO_PATH_SUFFIX}`,
      hash: hashFileOrAbsent(tsconfigPath),
    },
  ];
}

function hashFileOrAbsent(filePath: string): string {
  try {
    const buf = fs.readFileSync(filePath);
    return createHash("sha256").update(buf).digest("hex").slice(0, 32);
  } catch (error) {
    discardError(error);
    return "absent";
  }
}

let cachedAnalyzerVersion: string | null = null;
function getAnalyzerVersion(): string {
  if (cachedAnalyzerVersion !== null) return cachedAnalyzerVersion;
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const pkgPath = path.resolve(here, "..", "..", "..", "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    cachedAnalyzerVersion = pkg.version ?? "unknown";
  } catch (error) {
    discardError(error);
    cachedAnalyzerVersion = "unknown";
  }
  return cachedAnalyzerVersion;
}

function discardError(_captured: unknown): null {
  return null;
}
