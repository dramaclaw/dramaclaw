// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { createCanvasStore } from "@/features/canvas/core/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import {
  createNodeCanvasCommandEnvironment,
  createNodeCanvasEnvironment,
} from "@/features/canvas/infrastructure/nodeCanvasEnvironment";

const translate = (key: string) => key;

function numberedIds(prefix: string) {
  let counter = 0;
  return { next: () => `${prefix}-${(counter += 1)}` };
}

describe("Node canvas environment", () => {
  it("limits video references by the selected model in the catalog it was given", () => {
    const store = createCanvasStore(createNodeCanvasEnvironment({
      translate,
      ids: numberedIds("n"),
      videoModels: [
        { id: "single-image", referenceImageMax: 1, referenceVideoMax: 0, referenceAudioMax: 0 },
        { id: "four-images", referenceImageMax: 4 },
      ],
    }));
    const video = store.getState().addNode(CANVAS_NODE_TYPES.video, { x: 600, y: 0 });
    const first = store.getState().addNode(CANVAS_NODE_TYPES.imageGen, { x: 0, y: 0 });
    const second = store.getState().addNode(CANVAS_NODE_TYPES.imageGen, { x: 0, y: 300 });

    const firstEdge = store.getState().addEdge(first, video);
    const refusedEdge = store.getState().addEdge(second, video);
    store.getState().updateNodeData(video, { model: "four-images" });
    const secondEdge = store.getState().addEdge(second, video);

    expect([firstEdge, refusedEdge, secondEdge]).toEqual(["e-n-2-n-1", null, "e-n-3-n-1"]);
  });

  it("starts video nodes from the model it remembers, else the default", () => {
    const remembering = createCanvasStore(
      createNodeCanvasEnvironment({ translate, lastVideoModel: "picked-before" }),
    );
    const fresh = createCanvasStore(createNodeCanvasEnvironment({ translate }));

    const remembered = remembering.getState().addNode(CANVAS_NODE_TYPES.video, { x: 0, y: 0 });
    const defaulted = fresh.getState().addNode(CANVAS_NODE_TYPES.video, { x: 0, y: 0 });

    expect([
      remembering.getState().nodes.find((node) => node.id === remembered)?.data.model,
      fresh.getState().nodes.find((node) => node.id === defaulted)?.data.model,
    ]).toEqual(["picked-before", "newapi_seedance-2.0"]);
  });

  it("refuses previz scene edits unless the host supplies them", () => {
    const commandEnvironment = createNodeCanvasCommandEnvironment({
      translate,
      validate: () => ({ ok: true, issues: [] }),
    });

    expect(() => commandEnvironment.landSceneEdit("p-1", {}, { ops: [] })).toThrow(
      "previz scene edits are not available on this host",
    );
  });
});
