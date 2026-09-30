// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES, type GroupNodeData } from "@/features/canvas/domain/canvasNodes";
import { GroupNode } from "@/features/canvas/nodes/GroupNode";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  NodeResizeControl: ({ children }: { children?: React.ReactNode }) => children ?? null,
  Position: { Left: "left", Right: "right" },
  useReactFlow: () => ({
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NodeHeader: () => null,
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
}));

vi.mock("@/features/canvas/ui/NodeResizeHandle", () => ({
  NodeResizeHandle: () => null,
}));

describe("GroupNode geometry reconciliation", () => {
  let scheduledFrame: FrameRequestCallback | null;
  const fitGroupToChildren = vi.fn();

  beforeEach(() => {
    scheduledFrame = null;
    fitGroupToChildren.mockReset();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      scheduledFrame = callback;
      return 17;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useCanvasStore.setState({
      nodes: [
        {
          id: "workflow-group",
          type: CANVAS_NODE_TYPES.group,
          position: { x: 0, y: 0 },
          data: { displayName: "批量工作流" },
        },
        ...Array.from({ length: 37 }, (_, index) => ({
          id: `node-${index}`,
          type: CANVAS_NODE_TYPES.imageGen,
          parentId: "workflow-group",
          position: { x: index * 20, y: index * 10 },
          data: { prompt: `镜头 ${index}` },
        })),
      ],
      edges: [],
      dragHistorySnapshot: null,
      fitGroupToChildren,
    });
  });

  it("coalesces a large workflow group's measurement updates into one frame", () => {
    render(
      <GroupNode
        id="workflow-group"
        data={{ displayName: "批量工作流" } as GroupNodeData}
      />,
    );

    expect(fitGroupToChildren).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((node) =>
          node.id === "node-0"
            ? { ...node, measured: { width: 360, height: 240 } }
            : node,
        ),
      }));
    });

    expect(cancelAnimationFrame).toHaveBeenCalledWith(17);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    expect(fitGroupToChildren).not.toHaveBeenCalled();

    act(() => scheduledFrame?.(performance.now()));

    expect(fitGroupToChildren).toHaveBeenCalledOnce();
    expect(fitGroupToChildren).toHaveBeenCalledWith("workflow-group");
  });
});
