/**
 * @file Per-directory coverage floors. The global ratchet in .c8rc.json can be
 * satisfied by one well-tested area masking a regression in another, so each
 * top-level source group carries its own floor. Reads the c8 json-summary and
 * exits non-zero when any group falls below its floor.
 */

import { readFileSync } from "node:fs";

const SUMMARY = "coverage/coverage-summary.json";

/**
 * Floors sit just under the measured baseline; raise them as coverage grows.
 * `functions` is deliberately absent: c8 attributes function ranges through the
 * dist sourcemaps and undercounts them here. tests/server-units.test.ts drives
 * all six document-store operations, yet c8 scores that file 1/6 functions, so
 * a functions floor would gate on a number that does not reflect what ran.
 * Lines, statements, and branches remap reliably.
 */
const FLOORS = {
  "src/analyzer": { lines: 70, branches: 70 },
  "src/proxy": { lines: 83, branches: 70 },
  "src/server": { lines: 85, branches: 78 },
};

const METRICS = ["lines", "branches"];

/** Group key for a coverage-summary path, or null when it is outside src. */
function groupOf(absolutePath) {
  const rel = absolutePath.split(`${process.cwd()}/`).at(-1);
  const parts = rel.split("/");
  if (parts.length < 3 || parts[0] !== "src") return null;
  return `${parts[0]}/${parts[1]}`;
}

function main() {
  let summary;
  try {
    summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
  } catch (cause) {
    console.error(`coverage-gate: cannot read ${SUMMARY}: ${cause.message}`);
    console.error("coverage-gate: run `npm run test:coverage` so c8 writes the summary first.");
    process.exit(2);
  }

  const totals = new Map();
  const ungrouped = [];
  for (const [file, entry] of Object.entries(summary)) {
    if (file === "total") continue;
    const group = groupOf(file);
    if (group === null || FLOORS[group] === undefined) {
      ungrouped.push(file);
      continue;
    }
    const acc = totals.get(group) ?? Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]));
    for (const metric of METRICS) {
      acc[metric].covered += entry[metric].covered;
      acc[metric].total += entry[metric].total;
    }
    totals.set(group, acc);
  }

  const failures = [];
  // A src file outside every FLOORS group would be silently unmeasured, so the
  // gate refuses rather than reporting a pass it did not check.
  if (ungrouped.length > 0) {
    console.error("coverage-gate: these measured files belong to no floor group:");
    for (const f of ungrouped) console.error(`  ${f}`);
    console.error("coverage-gate: add the group to FLOORS or exclude the file in .c8rc.json.");
    process.exit(1);
  }
  console.log("group                 metric      actual   floor");
  for (const group of Object.keys(FLOORS)) {
    const acc = totals.get(group);
    if (acc === undefined) {
      failures.push(`${group}: no files measured (did the build or the include globs change?)`);
      continue;
    }
    for (const metric of METRICS) {
      const { covered, total } = acc[metric];
      const pct = total === 0 ? 100 : (100 * covered) / total;
      const floor = FLOORS[group][metric];
      const ok = pct >= floor;
      if (!ok) failures.push(`${group} ${metric}: ${pct.toFixed(2)}% < ${floor}%`);
      console.log(
        `${group.padEnd(21)} ${metric.padEnd(11)} ${pct.toFixed(2).padStart(6)}%  ${String(floor).padStart(5)}  ${ok ? "ok" : "FAIL"}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("\ncoverage-gate: per-directory floor(s) breached:");
    for (const line of failures) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log("\ncoverage-gate: all per-directory floors met.");
}

main();
