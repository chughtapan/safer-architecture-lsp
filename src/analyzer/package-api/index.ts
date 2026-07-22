/**
 * @file Package-API analysis barrel. Re-exports the package-exports
 * checks, public-surface analysis, public entrypoint resolution, and
 * package.json reading helpers consumed by the architecture rules.
 */

export {
  checkPackageExports,
} from "./package-exports.js";
export { checkPublicSurface } from "./public-surface.js";
export { publicApiFileNames } from "./public-entrypoints.js";
export {
  emptyPackageJson,
  readPackageJson,
} from "../project/api/index.js";
