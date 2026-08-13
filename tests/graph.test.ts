/**
 * @file Checks the graph primitives every architecture rule is built on:
 * lexicographic canonicalization of nodes and edges, strongly connected
 * component discovery, and canonical cycle paths. The 10,000-node case is
 * here because component search must stay iterative rather than recursive.
 */

import { FastCheck as fc } from "effect";
import { expect, it } from "vitest";
import {
  canonicalCyclePath,
  cyclicStronglyConnectedComponents,
  makeDirectedGraph,
  stronglyConnectedComponents,
} from "../src/analyzer/graph/index.js";

interface TestEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

/**
 * Edge sets spanning the component shapes the examples below each pin once:
 * a ring, two disjoint cycles, a cycle with a chord, an acyclic chain, and a
 * self loop. The invariant test draws its cases from all of them.
 */
const COMPONENT_SHAPES: ReadonlyArray<readonly TestEdge[]> = [
  [
    { from: "a", to: "b", label: "ab" },
    { from: "b", to: "c", label: "bc" },
    { from: "c", to: "a", label: "ca" },
  ],
  [
    { from: "x", to: "y", label: "xy" },
    { from: "y", to: "x", label: "yx" },
    { from: "p", to: "q", label: "pq" },
    { from: "q", to: "r", label: "qr" },
    { from: "r", to: "p", label: "rp" },
  ],
  [
    { from: "a", to: "b", label: "ab" },
    { from: "b", to: "a", label: "ba" },
    { from: "b", to: "c", label: "bc" },
    { from: "c", to: "a", label: "ca" },
  ],
  [
    { from: "m", to: "n", label: "mn" },
    { from: "n", to: "o", label: "no" },
  ],
  [{ from: "d", to: "d", label: "dd" }],
];

it("canonicalizes nodes and edges before graph traversal", () => {
  const graph = makeDirectedGraph<string, TestEdge>(
    ["c", "a"],
    [
      { from: "c", to: "a", label: "third" },
      { from: "b", to: "c", label: "second" },
      { from: "a", to: "b", label: "first" },
    ],
  );

  expect(graph.nodeIds).toEqual(["a", "b", "c"]);
  expect(graph.edges.map((edge) => edge.label)).toEqual(["first", "second", "third"]);
});

it("finds deterministic SCCs, isolated nodes, and self loops", () => {
  const edges: readonly TestEdge[] = [
    { from: "b", to: "c", label: "bc" },
    { from: "c", to: "a", label: "ca" },
    { from: "a", to: "b", label: "ab" },
    { from: "d", to: "d", label: "dd" },
  ];
  const graph = makeDirectedGraph<string, TestEdge>(["e"], edges);

  expect(stronglyConnectedComponents(graph)).toEqual([
    ["a", "b", "c"],
    ["d"],
    ["e"],
  ]);
  expect(cyclicStronglyConnectedComponents(graph)).toEqual([
    ["a", "b", "c"],
    ["d"],
  ]);
  expect(canonicalCyclePath(graph, ["c", "b", "a"])).toEqual([
    "a",
    "b",
    "c",
    "a",
  ]);
  expect(canonicalCyclePath(graph, ["d"])).toEqual(["d", "d"]);
});

it("returns no canonical path for an empty component", () => {
  const graph = makeDirectedGraph<string, TestEdge>([], []);
  expect(canonicalCyclePath(graph, [])).toEqual([]);
});

it("handles a large SCC without exhausting the JavaScript stack", () => {
  const size = 10_000;
  const nodes: string[] = [];
  for (let index = 0; index < size; index += 1) {
    nodes.push(`node-${String(index).padStart(5, "0")}`);
  }
  const edges: TestEdge[] = nodes.map((node, index) => ({
    from: node,
    to: nodes[(index + 1) % size],
    label: `edge-${index}`,
  }));
  const graph = makeDirectedGraph(nodes, edges);
  const components = cyclicStronglyConnectedComponents(graph);
  expect(components).toHaveLength(1);
  expect(components[0]).toHaveLength(size);
  expect(canonicalCyclePath(graph, components[0] ?? [])).toHaveLength(size + 1);
});

it("partitions every node once and names a real closed cycle for every component shape", () => {
  fc.assert(
    fc.property(fc.constantFrom(...COMPONENT_SHAPES), (edges) => {
      const graph = makeDirectedGraph<string, TestEdge>([], edges);
      const components = stronglyConnectedComponents(graph);
      // Tarjan must place every node in exactly one component, so flattening the
      // components reproduces the node set with nothing lost and nothing repeated.
      expect([...components.flat()].sort(byNodeId)).toEqual([...graph.nodeIds]);

      const cyclicKeys = new Set(
        cyclicStronglyConnectedComponents(graph).map((component) => component.join(",")),
      );
      for (const component of components) {
        const cyclePath = canonicalCyclePath(graph, component);
        if (!cyclicKeys.has(component.join(","))) {
          // An acyclic component has no cycle to name, so there is no path to report.
          expect(cyclePath).toEqual([]);
          continue;
        }
        // A canonical cycle is rooted at the component's smallest node and closes
        // back on it, which is what makes the reported path stable across runs.
        expect(cyclePath[0]).toBe([...component].sort(byNodeId)[0]);
        expect(cyclePath.at(-1)).toBe(cyclePath[0]);
        for (const [index, from] of cyclePath.slice(0, -1).entries()) {
          const to = cyclePath[index + 1];
          // Every step must be an edge the graph actually holds; a path through
          // an edge that does not exist would send a reader hunting for it.
          expect(graph.outgoing.get(from)?.some((edge) => edge.to === to)).toBe(true);
        }
      }
    }),
    // Each shape is in-memory and cheap, so the run budget is set high enough
    // that every one of them is drawn rather than sampled thin.
    { numRuns: COMPONENT_SHAPES.length * 8 },
  );
});

function byNodeId(left: string, right: string): number {
  return left.localeCompare(right);
}
