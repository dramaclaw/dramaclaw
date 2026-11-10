// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Runs in the plain Node project: no DOM, no window, no browser test setup.
import { describe, expect, it } from "vitest";

import {
  applyCanvasCommandsNow,
  createCanvasStore,
  createNodeCanvasCommandEnvironment,
  createNodeCanvasEnvironment,
  type CanvasChatCommandEnvelope,
} from "@/features/canvas/nodeEntry";

import { structuralEnvelopes } from "./structuralEnvelopes";

const translate = (key: string) => key;

function nodeStore() {
  let counter = 0;
  return createCanvasStore(
    createNodeCanvasEnvironment({ translate, ids: { next: () => `n-${(counter += 1)}` } }),
  );
}

function acceptingHost(updated: string[] = []) {
  return createNodeCanvasCommandEnvironment({
    translate,
    validate: () => ({ ok: true, issues: [] }),
    onNodeDataUpdated: (nodeId) => updated.push(nodeId),
  });
}

function envelope(commands: CanvasChatCommandEnvelope["commands"]): CanvasChatCommandEnvelope[] {
  return [{ schema_version: "canvas_chat_commands.v1", commands }];
}

describe("canvas core in Node", () => {
  it("has no browser globals in this worker", () => {
    expect([typeof window, typeof document, typeof localStorage]).toEqual([
      "undefined",
      "undefined",
      "undefined",
    ]);
  });

  it("applies the same structural commands with the same result as in the browser", () => {
    const store = nodeStore();
    const updated: string[] = [];

    const result = applyCanvasCommandsNow(store, acceptingHost(updated), structuralEnvelopes());

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(6);
    expect(result.createdNodeIds).toEqual(["n-1", "n-2", "n-3"]);
    const state = store.getState();
    expect(state.nodes.map((node) => [node.id, node.type, node.position])).toEqual([
      ["n-1", "textAnnotationNode", { x: 15, y: 25 }],
      ["n-2", "imageGenNode", { x: 358, y: 20 }],
      ["n-3", "textAnnotationNode", { x: 900, y: 40 }],
    ]);
    expect(state.nodes.find((node) => node.id === "n-1")?.data.displayName).toBe("Renamed");
    expect(state.edges).toEqual([]);
    expect(state.selectedNodeId).toBe("n-1");
    expect(updated).toEqual(["n-1"]);
  });

  it("connects, lays out, groups, selects and deletes nodes", () => {
    const store = nodeStore();
    const host = acceptingHost();

    const built = applyCanvasCommandsNow(store, host, envelope([
      {
        type: "create_node",
        client_id: "a",
        node_type: "textAnnotationNode",
        position: { x: 0, y: 0 },
      },
      { type: "create_node", client_id: "b", node_type: "imageGenNode", position: { x: 0, y: 0 } },
      { type: "create_node", client_id: "c", node_type: "imageGenNode", position: { x: 0, y: 0 } },
      { type: "create_edge", source: "a", target: "b", link_type: "prompt_for" },
      { type: "layout_nodes", node_ids: ["a", "b", "c"], mode: "horizontal" },
      { type: "group_nodes", node_ids: ["b", "c"], label: "Shots" },
      { type: "select_nodes", node_ids: ["c"] },
    ]));

    expect(built.errors).toEqual([]);
    expect(built.commandResults.map((step) => [step.type, step.status])).toEqual([
      ["create_node", "success"],
      ["create_node", "success"],
      ["create_node", "success"],
      ["create_edge", "success"],
      ["layout_nodes", "success"],
      ["group_nodes", "success"],
      ["select_nodes", "success"],
    ]);
    const afterBuild = store.getState();
    expect(afterBuild.edges.map((edge) => [edge.source, edge.target])).toEqual([["n-1", "n-2"]]);
    expect(afterBuild.nodes.map((node) => [node.id, node.type, node.parentId ?? null])).toEqual([
      ["n-1", "textAnnotationNode", null],
      ["n-4", "groupNode", null],
      ["n-2", "imageGenNode", "n-4"],
      ["n-3", "imageGenNode", "n-4"],
    ]);
    expect(afterBuild.nodes.find((node) => node.id === "n-4")?.data.label).toBe("Shots");
    expect(afterBuild.selectedNodeId).toBe("n-3");

    const removed = applyCanvasCommandsNow(store, host, envelope([
      { type: "delete_nodes", node_ids: ["n-1"] },
    ]));

    expect(removed.errors).toEqual([]);
    expect(store.getState().nodes.map((node) => node.id)).toEqual(["n-4", "n-2", "n-3"]);
    expect(store.getState().edges).toEqual([]);

    const cleared = applyCanvasCommandsNow(store, host, envelope([{ type: "clear_canvas" }]));

    expect(cleared.errors).toEqual([]);
    expect(store.getState().nodes).toEqual([]);
  });

  it("reports host commands it has no handler for", () => {
    const result = applyCanvasCommandsNow(nodeStore(), acceptingHost(), envelope([
      { type: "run_workflow", scope: "canvas" },
    ]));

    expect(result.errors).toEqual(["run_workflow is not available in this environment"]);
  });

  it("applies nothing when the host's validation refuses the envelope", () => {
    const store = nodeStore();
    const host = createNodeCanvasCommandEnvironment({
      translate,
      validate: () => ({ ok: false, issues: [{ path: "commands[0]", message: "refused" }] }),
    });

    const result = applyCanvasCommandsNow(store, host, envelope([
      { type: "create_node", node_type: "textAnnotationNode" },
    ]));

    expect([result.applied, result.errors, store.getState().nodes]).toEqual([
      0,
      ["commands[0]: refused"],
      [],
    ]);
  });
});
