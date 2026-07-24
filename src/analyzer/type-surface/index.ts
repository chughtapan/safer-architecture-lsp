/**
 * @file Type-surface analysis barrel. Re-exports the public vendor /
 * infrastructure type-leak checks and the boundary-owned type
 * requirement enforced on package exports.
 */

export {
  checkPublicVendorTypeLeaks,
  packageAllowedInPublicTypes,
  publicTypePackageForSpecifier,
} from "./type-leaks.js";
