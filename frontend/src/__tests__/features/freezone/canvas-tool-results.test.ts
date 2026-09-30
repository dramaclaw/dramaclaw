// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  replayPendingCanvasCommandFollowups,
  reportCanvasCommandToolResult,
} from "@/features/freezone/canvasCommandToolResult";
import { reportCanvasContextToolResult } from "@/features/freezone/canvasContextToolResult";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    post: vi.fn(() => Promise.resolve({ ok: true })),
  },
}));

describe("Freezone canvas tool result reporting", () => {
  beforeEach(() => {
    vi.mocked(api.post).mockClear();
  });

  it("reports canvas command results with the originating agent id", () => {
    reportCanvasCommandToolResult({
      bridgeKey: "bridge-a",
      turnId: "turn-a",
      projectId: "project-a",
      canvasId: "canvas-a",
      agentId: "agent-2",
      result: {
        applied: 1,
        openedUiActions: 0,
        createdNodeIds: ["node-a"],
        errors: [],
        commandResults: [
          {
            commandIndex: 0,
            type: "create_node",
            status: "success",
            label: "创建节点",
          },
        ],
      },
    });

    expect(api.post).toHaveBeenCalledWith("api/v1/chat/canvas-command-tool-result", {
      json: expect.objectContaining({ agent_id: "agent-2" }),
      timeout: 30_000,
    });
  });

  it("reports background workflow acceptance without claiming completion", () => {
    reportCanvasCommandToolResult({
      bridgeKey: "bridge-workflow",
      turnId: "turn-a",
      projectId: "project-a",
      canvasId: "canvas-a",
      accepted: true,
    });

    expect(api.post).toHaveBeenCalledWith("api/v1/chat/canvas-command-tool-result", {
      json: expect.objectContaining({
        tool_call_status: "completed",
        canvas_apply_status: "accepted",
        applied: true,
        cancelled: false,
        errors: [],
        message: "Canvas command was submitted to the canvas.",
        agent_hint: expect.stringContaining("submitted to the canvas"),
      }),
      timeout: 30_000,
    });
  });

  it("reports a completed run with an unsynced canvas artifact as pending", () => {
    reportCanvasCommandToolResult({
      bridgeKey: "bridge-unsynced",
      turnId: "turn-a",
      projectId: "project-a",
      canvasId: "canvas-a",
      result: {
        applied: 1,
        openedUiActions: 0,
        createdNodeIds: [],
        errors: [],
        commandResults: [
          { commandIndex: 0, type: "run_workflow", status: "success", label: "运行工作流" },
          {
            commandIndex: 0,
            type: "run_node_action",
            status: "pending",
            label: "生成图片（产物待同步）",
            nodeId: "image-a",
            action: "generate_image",
          },
        ],
      },
    });

    expect(api.post).toHaveBeenCalledWith("api/v1/chat/canvas-command-tool-result", {
      json: expect.objectContaining({
        canvas_apply_status: "pending",
        applied: false,
        message: expect.stringContaining("待同步"),
        agent_hint: expect.stringContaining("Do not rerun generation"),
      }),
      timeout: 30_000,
    });
  });

  it("describes server reconciliation separately from missing canvas output", () => {
    reportCanvasCommandToolResult({
      bridgeKey: "bridge-reconciliation",
      result: {
        applied: 0, openedUiActions: 0, createdNodeIds: [], errors: [],
        commandResults: [{
          commandIndex: 0, type: "run_node_action", status: "pending", label: "生成图片",
          output: { pending: true, reason: "workflow_server_reconciliation_pending" },
        }],
      },
    });
    expect(api.post).toHaveBeenLastCalledWith("api/v1/chat/canvas-command-tool-result", {
      json: expect.objectContaining({
        canvas_apply_status: "pending",
        message: expect.stringContaining("服务端仍在核对"),
        agent_hint: expect.stringContaining("server is still verifying"),
      }),
      timeout: 30_000,
    });
  });

  it("sends a distinct follow-up after background acceptance", () => {
    reportCanvasCommandToolResult({
      bridgeKey: "bridge-background",
      turnId: "turn-a",
      projectId: "project-a",
      canvasId: "canvas-a",
      accepted: true,
    });
    reportCanvasCommandToolResult({
      bridgeKey: "bridge-background",
      turnId: "turn-a",
      projectId: "project-a",
      canvasId: "canvas-a",
      followup: true,
      result: {
        applied: 0, openedUiActions: 0, createdNodeIds: [], errors: [],
        commandResults: [{
          commandIndex: 0, type: "run_node_action", status: "pending",
          label: "生成图片", output: { pending: true, reason: "workflow_result_sync_pending" },
        }],
      },
    });
    expect(api.post).toHaveBeenLastCalledWith("api/v1/chat/canvas-command-tool-result", {
      json: expect.objectContaining({
        bridge_key: "bridge-background",
        followup: true,
        canvas_apply_status: "pending",
        agent_hint: expect.stringContaining("Do not rerun generation"),
      }),
      timeout: 30_000,
    });
  });

  it("keeps an unsent follow-up separate from the accepted bridge receipt", () => {
    vi.mocked(api.post).mockImplementationOnce(() => new Promise(() => {}) as ReturnType<typeof api.post>);
    vi.mocked(api.post).mockImplementationOnce(() => new Promise(() => {}) as ReturnType<typeof api.post>);
    reportCanvasCommandToolResult({
      bridgeKey: "bridge-replay", accepted: true,
    });
    reportCanvasCommandToolResult({
      bridgeKey: "bridge-replay", followup: true,
      result: {
        applied: 0, openedUiActions: 0, createdNodeIds: [], errors: [],
        commandResults: [{ commandIndex: 0, type: "run_node_action", status: "pending", label: "待同步" }],
      },
    });
    const receipts = JSON.parse(window.localStorage.getItem("dramaclaw.canvas-command-receipts.v1") ?? "{}");
    expect(receipts["bridge-replay"].payload.canvas_apply_status).toBe("accepted");
    expect(receipts["bridge-replay:followup"].payload.canvas_apply_status).toBe("pending");

    replayPendingCanvasCommandFollowups();
    expect(api.post).toHaveBeenCalledTimes(3);
    expect(api.post).toHaveBeenLastCalledWith("api/v1/chat/canvas-command-tool-result", {
      json: expect.objectContaining({ bridge_key: "bridge-replay", followup: true }),
      timeout: 30_000,
    });
  });

  it("reports canvas context results with the originating agent id", () => {
    reportCanvasContextToolResult({
      bridgeKey: "bridge-a",
      turnId: "turn-a",
      projectId: "project-a",
      canvasId: "canvas-a",
      agentId: "agent-2",
      responses: [{ ok: true }],
    });

    expect(api.post).toHaveBeenCalledWith("api/v1/chat/canvas-context-tool-result", {
      json: expect.objectContaining({ agent_id: "agent-2" }),
      timeout: 30_000,
    });
  });
});
