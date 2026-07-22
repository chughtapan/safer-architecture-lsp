/**
 * @file Architecture report cache. Layered: a per-workspace in-memory
 * cache with the configurable `cacheTtlMs` TTL, backed by a persistent
 * on-disk report under `node_modules/.cache/agent-code-guard/` that
 * survives across linter processes.
 *
 * Workspace scoping: state is owned by a `WorkspaceCache` instance per
 * `projectRoot`. Long-lived hosts obtain the relevant instance from the
 * process-level registry and invalidate only that workspace, so workspace
 * A's edits do not blow workspace B's cache.
 */

import type ts from "typescript";
import { analyzeResolvedArchitecture } from "../../index.js";
import type { ArchitectureReport, ResolvedArchitectureOptions } from "../diagnostics/index.js";
import { createProgram } from "../source-files.js";
import {
  computeFileWatermark,
  hashOptions,
  hydrateReport,
  readDiskCache,
  watermarksMatch,
  writeDiskCache,
} from "./disk-cache.js";

interface CachedReport {
  readonly report: ArchitectureReport;
  readonly expiresAt: number;
}

/**
 * Per-workspace cache for the architecture report. Owns its own
 * in-memory map plus the option-key memoization. The disk-cache layer
 * is shared across workspaces but partitioned on `projectRoot`, so two
 * instances over different roots never collide on the same file.
 */
export class WorkspaceCache {
  readonly #reportCache = new Map<string, CachedReport>();
  readonly #keyCache = new WeakMap<ResolvedArchitectureOptions, string>();

  /**
   * Read or build the architecture report for this workspace. Hits the
   * in-memory entry first, then the disk cache, then the analyzer. The
   * disk-cache path is skipped when `programFingerprint` is supplied
   * (long-lived hosts with in-memory `ts.Program` overlays), so unsaved
   * LSP buffers never collide with the persisted disk report.
   * @param options Resolved architecture options for this workspace.
   * @param programProvider Lazy `ts.Program` source on cache miss.
   * @param programFingerprint Stable identifier of the program supplied
   * by `programProvider` (e.g., LSP `LanguageService` version). When
   * omitted, the cache treats the program as the canonical disk-backed
   * one.
   * @returns The architecture report.
   */
  get(
    options: ResolvedArchitectureOptions,
    programProvider: () => ts.Program | null = () => createProgram(options),
    programFingerprint?: string,
  ): ArchitectureReport {
    const optionsKey = this.#optionsKey(options);
    const cacheKey =
      programFingerprint === undefined ? optionsKey : `${optionsKey}|${programFingerprint}`;
    const now = Date.now();
    const cached = this.#reportCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) return cached.report;

    const fromDisk =
      programFingerprint === undefined ? this.#loadFromDiskCache(options) : null;
    if (fromDisk !== null) {
      this.#reportCache.set(cacheKey, {
        report: fromDisk,
        expiresAt: now + options.cacheTtlMs,
      });
      return fromDisk;
    }

    const report = analyzeResolvedArchitecture(options, programProvider);
    this.#reportCache.set(cacheKey, { report, expiresAt: now + options.cacheTtlMs });
    if (programFingerprint === undefined) this.#persistToDiskCache(options, report);
    return report;
  }

  /**
   * Drop every entry from this workspace's in-memory cache. Does not
   * touch the on-disk report — that stays valid as long as its
   * watermark matches.
   */
  clear(): void {
    this.#reportCache.clear();
  }

  #optionsKey(options: ResolvedArchitectureOptions): string {
    const cached = this.#keyCache.get(options);
    if (cached !== undefined) return cached;
    const key = JSON.stringify(options);
    this.#keyCache.set(options, key);
    return key;
  }

  #loadFromDiskCache(options: ResolvedArchitectureOptions): ArchitectureReport | null {
    const persisted = readDiskCache(options.projectRoot);
    if (persisted === null) return null;
    if (persisted.optionsHash !== hashOptions(options)) return null;
    const currentWatermark = computeFileWatermark(options);
    if (!watermarksMatch(persisted.files, currentWatermark)) return null;
    return hydrateReport(persisted);
  }

  #persistToDiskCache(options: ResolvedArchitectureOptions, report: ArchitectureReport): void {
    try {
      const files = computeFileWatermark(options);
      writeDiskCache(options.projectRoot, report, files, hashOptions(options));
    } catch (error) {
      discardCacheWriteError(error);
    }
  }
}

function discardCacheWriteError(_captured: unknown): void {
  // Best-effort: a write failure (read-only filesystem, missing
  // node_modules) must not break the lint. The in-memory cache still
  // covers the rest of this process.
}

const workspaceCaches = new Map<string, WorkspaceCache>();

/**
 * Get or create the cache instance for a given project root. Long-lived
 * hosts (LSP server, etc.) call this to obtain a stable per-workspace
 * cache they can `clear()` independently from other workspaces in the
 * same process.
 * @param projectRoot Absolute project root.
 * @returns The cache instance for this workspace.
 */
export function getOrCreateWorkspaceCache(projectRoot: string): WorkspaceCache {
  let cache = workspaceCaches.get(projectRoot);
  if (cache === undefined) {
    cache = new WorkspaceCache();
    workspaceCaches.set(projectRoot, cache);
  }
  return cache;
}

/**
 * Drop the in-memory cache for a specific workspace, leaving other
 * workspaces' caches intact. Long-lived hosts call this on watcher
 * events scoped to that workspace.
 * @param projectRoot Absolute project root.
 */
export function clearWorkspaceCache(projectRoot: string): void {
  workspaceCaches.get(projectRoot)?.clear();
}
