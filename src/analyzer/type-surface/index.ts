/**
 * @file Type-surface analysis barrel. Re-exports the public vendor /
 * infrastructure type-leak checks and the boundary-owned type
 * requirement enforced on package exports.
 */

/**
 * The vendor type-leak pass, plus the two classifiers that decide which
 * package a specifier belongs to and whether that package is allowed in
 * public types, so callers can reproduce a diagnostic's verdict.
 */
export {
  checkPublicVendorTypeLeaks,
  packageAllowedInPublicTypes,
  publicTypePackageForSpecifier,
} from "./type-leaks.js";
