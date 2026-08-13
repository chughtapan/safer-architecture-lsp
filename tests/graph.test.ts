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
  const nodes = Array.from({ length: size }, (_, index) => `node-${String(index).padStart(5, "0")}`);
  const edges: TestEdge[] = nodes.map((node, index) => ({
    from: node,
    to: nodes[(index + 1) % size] as string,
    label: `edge-${index}`,
  }));
  const graph = makeDirectedGraph(nodes, edges);
  const components = cyclicStronglyConnectedComponents(graph);
  expect(components).toHaveLength(1);
  expect(components[0]).toHaveLength(size);
  expect(canonicalCyclePath(graph, components[0] ?? [])).toHaveLength(size + 1);
});
