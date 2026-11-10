// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  addEdge as flowAddEdge,
  applyEdgeChanges as flowApplyEdgeChanges,
  applyNodeChanges as flowApplyNodeChanges,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { describe, expect, it } from "vitest";

import { addEdge, applyEdgeChanges, applyNodeChanges } from "@/features/canvas/core/graphChanges";

function nodes(): Node[] {
  return [
    { id: "a", position: { x: 0, y: 0 }, data: {} },
    { id: "b", position: { x: 10, y: 0 }, data: {}, width: 50, height: 40 },
    { id: "c", position: { x: 20, y: 0 }, data: {} },
    { id: "d", position: { x: 30, y: 0 }, data: {} },
    { id: "e", position: { x: 40, y: 0 }, data: {} },
  ];
}

function edges(): Edge[] {
  return [
    { id: "e1", source: "a", target: "b" },
    { id: "e2", source: "b", target: "c", sourceHandle: "out", targetHandle: "in" },
    { id: "e3", source: "c", target: "d" },
  ];
}

const nodeChanges: NodeChange[] = [
  { type: "select", id: "a", selected: true },
  { type: "position", id: "a", position: { x: 5, y: 6 }, dragging: true },
  { type: "position", id: "a", dragging: false },
  { type: "dimensions", id: "b", dimensions: { width: 80, height: 60 }, setAttributes: true },
  { type: "dimensions", id: "c", dimensions: { width: 70, height: 30 }, setAttributes: "width" },
  { type: "dimensions", id: "c", resizing: false },
  { type: "dimensions", id: "d", dimensions: { width: 90, height: 20 }, setAttributes: "height" },
  { type: "position", id: "e", position: { x: 1, y: 1 } },
  { type: "remove", id: "e" },
  { type: "add", item: { id: "f", position: { x: 0, y: 9 }, data: {} }, index: 1 },
  { type: "add", item: { id: "g", position: { x: 0, y: 8 }, data: {} } },
  { type: "replace", id: "d", item: { id: "d", position: { x: 3, y: 3 }, data: { kept: 1 } } },
];

describe("graph change reducers", () => {
  it("apply node changes as the flow renderer does", () => {
    const before = nodes();
    const ours = applyNodeChanges(nodeChanges, before);

    expect(ours).toEqual(flowApplyNodeChanges(nodeChanges, nodes()));
    expect(ours.map((node) => node.id)).toEqual(["a", "f", "b", "c", "d", "g"]);
    expect(ours[0]).toEqual({
      id: "a",
      position: { x: 5, y: 6 },
      data: {},
      selected: true,
      dragging: false,
    });
    expect(ours[2]).toEqual({
      id: "b",
      position: { x: 10, y: 0 },
      data: {},
      width: 80,
      height: 60,
      measured: { width: 80, height: 60 },
    });
    expect(ours[3]).toEqual({
      id: "c",
      position: { x: 20, y: 0 },
      data: {},
      width: 70,
      measured: { width: 70, height: 30 },
      resizing: false,
    });
    expect(ours[4]).toEqual({ id: "d", position: { x: 3, y: 3 }, data: { kept: 1 } });
    expect(before[0]).toEqual({ id: "a", position: { x: 0, y: 0 }, data: {} });
  });

  it("keep untouched elements as the same objects", () => {
    const before = nodes();
    const after = applyNodeChanges([{ type: "select", id: "a", selected: true }], before);

    expect([after[0] === before[0], after[1] === before[1]]).toEqual([false, true]);
  });

  it("apply edge changes as the flow renderer does", () => {
    const changes: EdgeChange[] = [
      { type: "select", id: "e1", selected: true },
      { type: "remove", id: "e2" },
      { type: "replace", id: "e3", item: { id: "e3", source: "c", target: "a" } },
      { type: "add", item: { id: "e4", source: "d", target: "a" } },
    ];

    const ours = applyEdgeChanges(changes, edges());

    expect(ours).toEqual(flowApplyEdgeChanges(changes, edges()));
    expect(ours).toEqual([
      { id: "e1", source: "a", target: "b", selected: true },
      { id: "e3", source: "c", target: "a" },
      { id: "e4", source: "d", target: "a" },
    ]);
  });

  it("add edges with the flow renderer's ids, dedup and handle cleanup", () => {
    const cases: Array<Parameters<typeof flowAddEdge<Edge>>[0]> = [
      { source: "d", target: "a", sourceHandle: "out", targetHandle: null },
      { source: "d", target: "a", sourceHandle: null, targetHandle: null },
      { id: "custom", source: "d", target: "e" },
      { source: "a", target: "b", sourceHandle: null, targetHandle: null },
      { source: "b", target: "c", sourceHandle: "out", targetHandle: "in" },
      { source: "b", target: "c", sourceHandle: "other", targetHandle: "in" },
      { source: "", target: "c", sourceHandle: null, targetHandle: null },
    ];

    const ours = cases.map((params) => addEdge(params, edges()));

    expect(ours).toEqual(cases.map((params) => flowAddEdge(params, edges())));
    expect(ours.map((list) => list.slice(3))).toEqual([
      [{ id: "xy-edge__dout-a", source: "d", target: "a", sourceHandle: "out" }],
      [{ id: "xy-edge__d-a", source: "d", target: "a" }],
      [{ id: "custom", source: "d", target: "e" }],
      [],
      [],
      [
        {
          id: "xy-edge__bother-cin",
          source: "b",
          target: "c",
          sourceHandle: "other",
          targetHandle: "in",
        },
      ],
      [],
    ]);
  });
});
