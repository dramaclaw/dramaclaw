// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { createCanvasStore } from "@/features/canvas/core/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

import { recordingEnvironment } from "./testEnvironment";

describe("createCanvasStore", () => {
  it("builds stores that do not share nodes with each other or the browser canvas", () => {
    const first = createCanvasStore(recordingEnvironment("a").environment);
    const second = createCanvasStore(recordingEnvironment("b").environment);
    useCanvasStore.getState().setCanvasData([], []);

    const created = first.getState().addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 10, y: 20 });

    expect(created).toBe("a-1");
    expect(first.getState().nodes.map((node) => [node.id, node.position])).toEqual([
      ["a-1", { x: 10, y: 20 }],
    ]);
    expect(second.getState().nodes).toEqual([]);
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it("names new groups through the environment translator", () => {
    const store = createCanvasStore(recordingEnvironment("g").environment);
    const left = store.getState().addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });
    const right = store.getState().addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 600, y: 0 });

    const groupId = store.getState().groupNodes([left, right]);

    const group = store.getState().nodes.find((node) => node.id === groupId);
    expect(groupId).toBe("g-3");
    expect(group?.data.label).toBe('canvas.naming.group {"index":1}');
  });

  it("tells the environment when nodes are deleted and when the canvas is replaced", () => {
    const recorder = recordingEnvironment("d");
    const store = createCanvasStore(recorder.environment);
    const nodeId = store.getState().addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });

    store.getState().deleteNodes([nodeId]);
    store.getState().setCanvasData([], []);
    store.getState().clearCanvas();

    expect(recorder.events).toEqual(["deleted d-1", "canvas replaced", "canvas replaced"]);
  });
});
