/**
 * @file Package-API analysis barrel. Re-exports the package-exports
 * checks, public-surface analysis, public entrypoint resolution, and
 * package.json reading helpers consumed by the architecture rules.
 */

/**
 * Manifest reading, forwarded from the project layer so a caller can load a
 * `package.json` and run the checks below from a single import.
 */
export {
  emptyPackageJson,
  readPackageJson,
} from "../project/api/index.js";
/**
 * Manifest-level check that reads the `exports` map and reports internal
 * paths, oversized subpath lists, wildcards, and test-only entrypoints.
 */
export {
  checkPackageExports,
} from "./package-exports.js";
/**
 * Resolves the source files a manifest actually publishes. The surface checks
 * treat only those files as package boundaries.
 */
export { publicApiFileNames } from "./public-entrypoints.js";
/**
 * Graph-level check that reports export-star boundaries, oversized facades,
 * leaked test helpers, and vendor types reaching the published modules.
 */
export { checkPublicSurface } from "./public-surface.js";
