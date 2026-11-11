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

  it("starts video nodes from the environment's last video model when created or loaded", () => {
    const store = createCanvasStore(
      recordingEnvironment("v", { lastVideoModel: "remembered-video-model" }).environment,
    );

    const created = store.getState().addNode(CANVAS_NODE_TYPES.video, { x: 0, y: 0 });
    store.getState().setCanvasData(
      [
        ...store.getState().nodes,
        { id: "loaded", type: CANVAS_NODE_TYPES.video, position: { x: 400, y: 0 }, data: {} },
      ],
      [],
    );

    expect(store.getState().nodes.map((node) => [node.id, node.data.model])).toEqual([
      [created, "remembered-video-model"],
      ["loaded", "remembered-video-model"],
    ]);
  });

  it("falls back to the default video model when the environment remembers none", () => {
    const store = createCanvasStore(recordingEnvironment("v").environment);

    const created = store.getState().addNode(CANVAS_NODE_TYPES.video, { x: 0, y: 0 });

    expect(store.getState().nodes.find((node) => node.id === created)?.data.model)
      .toBe("newapi_seedance-2.0");
  });

  it("limits video references with the envelope the environment resolves", () => {
    const recorder = recordingEnvironment("r", {
      videoReferenceEnvelope: { image: 1, video: 0, audio: 0, total: 1 },
    });
    const store = createCanvasStore(recorder.environment);
    const video = store.getState().addNode(CANVAS_NODE_TYPES.video, { x: 600, y: 0 });
    const first = store.getState().addNode(CANVAS_NODE_TYPES.imageGen, { x: 0, y: 0 });
    const second = store.getState().addNode(CANVAS_NODE_TYPES.imageGen, { x: 0, y: 300 });

    const accepted = store.getState().addEdge(first, video);
    const rejected = store.getState().addEdge(second, video);

    expect(accepted).toBe(`e-${first}-${video}`);
    expect(rejected).toBeNull();
    expect(store.getState().edges.map((edge) => edge.id)).toEqual([`e-${first}-${video}`]);
    expect(recorder.events).toContain("envelope for r-1");
  });
});


it('preserves server-owned loading on load before a task handle exists', () => {
  const store = createCanvasStore(recordingEnvironment('load').environment);
  store.getState().setCanvasData([
    { id: 'server', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 },
      data: { imageUrl: null, isGenerating: true, generationOwner: 'server', generationRunId: 'run' } },
    { id: 'browser', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 },
      data: { imageUrl: null, isGenerating: true } },
  ], []);
  expect(store.getState().nodes.map(node => [node.id, node.data.isGenerating]))
    .toEqual([['server', true], ['browser', false]]);
  expect(store.getState().nodes[0].data.generationRunId).toBe('run');
});
