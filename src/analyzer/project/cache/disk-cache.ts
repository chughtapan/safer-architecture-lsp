/**
 * @file Persistent on-disk cache for the architecture report. Loads
 * the cached report when a content-hash watermark over project source
 * files matches the previous run, so a fresh ESLint process can skip
 * the full analyzer cold-build (~3 s on a 1500-file project).
 *
 * Cache location: `node_modules/.cache/agent-code-guard/report.json`
 * under the project root. Auto-gitignored under `node_modules/` and
 * auto-cleaned by package managers that prune the `.cache` directory.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type {
  ArchitectureDiagnostic,
  ArchitectureReport,
  ResolvedArchitectureOptions,
} from "../diagnostics/index.js";
import { dependencyWatermarks } from "./dependency-watermark.js";

// v2 bumped 2026-05-12: watermark now includes package.json, tsconfig
// content, and analyzer version so dependency / config edits invalidate.
// v1 caches read as null on next call.
const CACHE_VERSION = 2;
const CACHE_DIR_SEGMENTS = ["node_modules", ".cache", "agent-code-guard"];
const CACHE_FILE = "report.json";

function discardCacheError(_captured: unknown): null {
  // Disk cache is best-effort. A malformed file, permission error, or
  // race against another lint must never block the linter; we fall back
  // to a fresh analyzer build. The error is captured for future
  // debugging via Node inspector if needed.
  return null;
}

interface FileWatermark {
  readonly path: string;
  readonly hash: string;
}

interface PersistedReport {
  readonly version: number;
  readonly capturedAt: string;
  readonly optionsHash: string;
  readonly files: readonly FileWatermark[];
  readonly diagnostics: readonly ArchitectureDiagnostic[];
  readonly diagnosticsByFile: Record<string, readonly ArchitectureDiagnostic[]>;
}

function cacheFilePathFor(projectRoot: string): string {
  return path.join(projectRoot, ...CACHE_DIR_SEGMENTS, CACHE_FILE);
}

/**
 * Read and validate a persisted report. Returns `null` when the file
 * is absent, malformed, or built against an older schema version.
 * @param projectRoot Absolute project root.
 * @returns The deserialized report and watermark, or `null`.
 */
export function readDiskCache(projectRoot: string): PersistedReport | null {
  const filePath = cacheFilePathFor(projectRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as PersistedReport;
    if (parsed.version !== CACHE_VERSION) return null;
    return parsed;
  } catch (error) {
    return discardCacheError(error);
  }
}

/**
 * Persist a report along with its source-file watermark and the
 * options hash it was built against.
 * @param projectRoot Absolute project root.
 * @param report The freshly built architecture report to persist.
 * @param files Per-file watermark covering every project source file.
 * @param optionsHash Stable hash of the resolved options that produced
 * the report.
 */
export function writeDiskCache(
  projectRoot: string,
  report: ArchitectureReport,
  files: readonly FileWatermark[],
  optionsHash: string,
): void {
  const filePath = cacheFilePathFor(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const diagnosticsByFile: Record<string, readonly ArchitectureDiagnostic[]> = {};
  for (const [k, v] of report.diagnosticsByFile.entries()) diagnosticsByFile[k] = v;

  const payload: PersistedReport = {
    version: CACHE_VERSION,
    capturedAt: new Date().toISOString(),
    optionsHash,
    files,
    diagnostics: report.diagnostics,
    diagnosticsByFile,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload));
}

/**
 * Rehydrate a persisted report into the in-memory shape (Map for the
 * `diagnosticsByFile` field) the rest of the analyzer expects.
 * @param persisted Loaded persisted-report payload.
 * @returns The in-memory `ArchitectureReport` shape.
 */
export function hydrateReport(persisted: PersistedReport): ArchitectureReport {
  const byFile = new Map<string, readonly ArchitectureDiagnostic[]>();
  for (const [k, v] of Object.entries(persisted.diagnosticsByFile)) byFile.set(k, v);
  return { diagnostics: persisted.diagnostics, diagnosticsByFile: byFile };
}

/**
 * Compute a content-hash watermark over every source file the analyzer
 * would see. Reads each file from disk and digests sha256-128; total
 * cost is the I/O.
 * @param options Resolved architecture options (used to locate the
 * tsconfig that enumerates source files).
 * @returns Per-file watermark sorted by path for stable comparison.
 */
export function computeFileWatermark(
  options: ResolvedArchitectureOptions,
): readonly FileWatermark[] {
  const fileNames = enumerateProjectFiles(options);
  const watermarks: FileWatermark[] = [];
  for (const filePath of fileNames) {
    try {
      const buf = fs.readFileSync(filePath);
      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 32);
      watermarks.push({ path: filePath, hash });
    } catch (error) {
      discardCacheError(error);
      // File enumerated by tsconfig but unreadable now (race or stale
      // tsconfig). Treat as cache-busting by inventing a unique hash.
      watermarks.push({ path: filePath, hash: `missing-${Date.now()}` });
    }
  }
  // Pseudo-watermarks for analyzer behavior inputs that aren't source
  // files: edits to any of these change the report even when no .ts
  // file changed, so the watermark must capture them.
  const tsconfigFinder = (root: string): string | undefined =>
    ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json") ?? undefined;
  for (const extra of dependencyWatermarks(options, tsconfigFinder)) {
    watermarks.push(extra);
  }
  watermarks.sort((left, right) => left.path.localeCompare(right.path));
  return watermarks;
}

function enumerateProjectFiles(options: ResolvedArchitectureOptions): readonly string[] {
  const configPath =
    options.tsconfigPath ?? ts.findConfigFile(options.projectRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) return [];
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );
  if (parsed.errors.length > 0) return [];
  const root = path.resolve(options.projectRoot);
  return parsed.fileNames.filter((file) =>
    path.resolve(file).startsWith(root + path.sep) &&
    !file.includes(`${path.sep}node_modules${path.sep}`),
  );
}

/**
 * Stable hash of resolved options. Used to invalidate the disk cache
 * when consumer config changes (different thresholds, different
 * allowance lists) even though source files are unchanged.
 * @param options Resolved architecture options.
 * @returns Hex-truncated sha256 over the canonicalized options JSON.
 */
export function hashOptions(options: ResolvedArchitectureOptions): string {
  return createHash("sha256").update(JSON.stringify(options)).digest("hex").slice(0, 32);
}

/**
 * Compare two file watermarks for equality. Lengths must match and
 * every (path, hash) tuple must align — the canonicalized sort order
 * makes this O(n).
 * @param before Watermark from a prior run.
 * @param after Freshly computed watermark.
 * @returns `true` iff every entry matches.
 */
export function watermarksMatch(
  before: readonly FileWatermark[],
  after: readonly FileWatermark[],
): boolean {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i++) {
    if (before[i].path !== after[i].path || before[i].hash !== after[i].hash) return false;
  }
  return true;
}
