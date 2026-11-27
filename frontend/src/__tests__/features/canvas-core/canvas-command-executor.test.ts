// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { createCanvasStore } from "@/features/canvas/core/canvasStore";
import { applyCanvasCommandsNow } from "@/features/canvas/core/commands/executor";
import { useCanvasStore } from "@/stores/canvasStore";

import { recordingCommandEnvironment, recordingEnvironment } from "./testEnvironment";
import { structuralEnvelopes } from "./structuralEnvelopes";

describe("canvas command executor", () => {
  it("applies structural commands to the store it is given", () => {
    const { environment } = recordingEnvironment("n");
    const store = createCanvasStore(environment);
    const { commandEnvironment, events } = recordingCommandEnvironment();

    const result = applyCanvasCommandsNow(store, commandEnvironment, structuralEnvelopes());

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(6);
    expect(result.createdNodeIds).toEqual(["n-1", "n-2", "n-3"]);
    expect(result.commandResults.map((step) => [step.type, step.status, step.label])).toEqual([
      ["create_node", "success", "创建节点"],
      ["add_next_node", "success", "添加下游节点"],
      ["create_node", "success", "创建节点"],
      ["move_nodes", "success", "移动节点"],
      ["update_node_data", "success", "更新节点"],
      ["delete_edges", "success", "断开连接"],
    ]);
    const state = store.getState();
    expect(state.nodes.map((node) => [node.id, node.type, node.position])).toEqual([
      ["n-1", "textAnnotationNode", { x: 15, y: 25 }],
      ["n-2", "imageGenNode", { x: 358, y: 20 }],
      ["n-3", "textAnnotationNode", { x: 900, y: 40 }],
    ]);
    expect(state.nodes.find((node) => node.id === "n-1")?.data.displayName).toBe("Renamed");
    expect(state.edges).toEqual([]);
    expect(state.selectedNodeId).toBe("n-1");
    expect(events).toEqual(["validate 1 envelope against 0 nodes", "node data updated n-1"]);
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it("reports commands the host cannot run instead of applying them", () => {
    const { environment } = recordingEnvironment("n");
    const store = createCanvasStore(environment);
    const { commandEnvironment } = recordingCommandEnvironment();

    const result = applyCanvasCommandsNow(store, commandEnvironment, [
      {
        schema_version: "canvas_chat_commands.v1",
        commands: [{ type: "run_workflow", scope: "canvas" }],
      },
    ]);

    expect(result.errors).toEqual(["run_workflow is not available in this environment"]);
    expect(result.commandResults).toEqual([
      {
        commandIndex: 0,
        type: "run_workflow",
        status: "error",
        label: "运行工作流",
        nodeId: undefined,
        action: undefined,
        error: "run_workflow is not available in this environment",
      },
    ]);
  });
});
