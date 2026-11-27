// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { ReactFlowProvider } from "@xyflow/react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CANVAS_NODE_TYPES,
  type VideoComposeNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { VideoComposeNode } from "@/features/canvas/nodes/VideoComposeNode";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: ({ titleText }: { titleText: string }) => <div>{titleText}</div>,
}));

beforeEach(() => {
  useCanvasStore.getState().setCanvasData(
    [
      ...["video-a", "video-b"].map((id) => ({
        id,
        type: CANVAS_NODE_TYPES.video,
        position: { x: 0, y: 0 },
        data: { videoUrl: `/media/${id}.mp4` },
      })),
      {
        id: "compose",
        type: CANVAS_NODE_TYPES.videoCompose,
        position: { x: 0, y: 0 },
        data: {},
      },
    ],
    [
      { id: "edge-a", source: "video-a", target: "compose" },
      { id: "edge-b", source: "video-b", target: "compose" },
    ],
  );
});

function renderNode(data: VideoComposeNodeData) {
  render(
    <ReactFlowProvider>
      <VideoComposeNode
        id="compose"
        type={CANVAS_NODE_TYPES.videoCompose}
        data={data}
        selected={false}
        dragging={false}
        draggable
        selectable
        deletable
        zIndex={0}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>,
  );
}

describe("compose node export status", () => {
  it("shows the failed export headline and backend error while keeping Studio available", () => {
    renderNode({
      isGenerating: false,
      generationError: "执行该任务的服务进程已退出,任务已中断,请重新发起",
    });

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("导出失败")).toBeInTheDocument();
    expect(
      within(alert).getByText("执行该任务的服务进程已退出,任务已中断,请重新发起"),
    ).toHaveAttribute("title", "执行该任务的服务进程已退出,任务已中断,请重新发起");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开视频合成与剪辑" })).toBeEnabled();
  });

  it("shows exporting instead of a stale error while the task runs", () => {
    renderNode({ isGenerating: true, generationError: "上次导出失败" });

    expect(screen.getByRole("status")).toHaveTextContent("正在导出…");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("上次导出失败")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开视频合成与剪辑" })).toBeEnabled();
  });

  it.each([undefined, " \n\t "])(
    "shows only the existing controls for an empty error (%j)",
    (generationError) => {
      renderNode({ isGenerating: false, generationError });

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "打开视频合成与剪辑" })).toBeEnabled();
    },
  );
});
