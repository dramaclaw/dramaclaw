// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { Canvas } from "@/features/canvas/Canvas";

// 小地图默认靠 hover 显示，指针一拖出去就会 onMouseLeave → 180ms 后卸载 MiniMap，
// 连带把 useSmoothMinimapPan 的 window 监听摘掉、拖动断在半路。这里断言的就是
// 「拖动期间小地图必须保持挂载」这条 Canvas 侧的接线。
let capturedPanOptions: {
  onPanStart?: () => void;
  onPanEnd?: (pointerInsideMinimap: boolean) => void;
} | null = null;

vi.mock("@/features/canvas/hooks/useSmoothMinimapPan", () => ({
  useSmoothMinimapPan: (options: {
    onPanStart?: () => void;
    onPanEnd?: (pointerInsideMinimap: boolean) => void;
  }) => {
    capturedPanOptions = options;
  },
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    ReactFlow: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="react-flow">{children}</div>
    ),
    Background: () => null,
    MiniMap: (props: { onMouseEnter?: () => void; onMouseLeave?: () => void }) => (
      <div
        data-testid="minimap"
        onMouseEnter={props.onMouseEnter}
        onMouseLeave={props.onMouseLeave}
      />
    ),
    useNodesInitialized: () => true,
    useReactFlow: () => ({
      fitView: vi.fn(),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      getZoom: () => 1,
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      setCenter: vi.fn(),
      setViewport: vi.fn(),
    }),
    useStoreApi: () => ({
      getState: () => ({ transform: [0, 0, 1] }),
      setState: vi.fn(),
      subscribe: () => () => {},
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/api/skills", () => ({
  getSkillRegistry: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/features/canvas/nodes", () => ({ nodeTypes: {} }));
vi.mock("@/features/canvas/edges", () => ({ edgeTypes: {} }));
vi.mock("@/features/canvas/NodeSelectionMenu", () => ({ NodeSelectionMenu: () => null }));
vi.mock("@/features/canvas/ui/SelectedNodeOverlay", () => ({ SelectedNodeOverlay: () => null }));
vi.mock("@/features/canvas/ui/MultiSelectionToolbar", () => ({ MultiSelectionToolbar: () => null }));
vi.mock("@/features/canvas/ui/MultiSelectionConnectButton", () => ({
  MultiSelectionConnectButton: () => null,
}));
vi.mock("@/features/canvas/ui/NodeSpawnPlusOverlay", () => ({ NodeSpawnPlusOverlay: () => null }));
vi.mock("@/features/canvas/ui/CanvasContextMenu", () => ({ CanvasContextMenu: () => null }));
vi.mock("@/features/canvas/ui/NodeToolDialog", () => ({ NodeToolDialog: () => null }));
vi.mock("@/features/canvas/ui/ImageViewerModal", () => ({ ImageViewerModal: () => null }));
vi.mock("@/features/canvas/ui/VideoViewerModal", () => ({ VideoViewerModal: () => null }));
vi.mock("@/features/canvas/ui/CanvasZoomControl", () => ({ CanvasZoomControl: () => null }));
vi.mock("@/features/canvas/ui/CanvasQuickActionBar", () => ({ CanvasQuickActionBar: () => null }));
vi.mock("@/features/canvas/ui/CanvasMinimapBookmarksOverlay", () => ({
  CanvasMinimapBookmarksOverlay: () => null,
}));
vi.mock("@/features/canvas/ui/CanvasMinimapButton", () => ({
  CanvasMinimapButton: (props: { onHoverChange: (hovered: boolean) => void }) => (
    <button
      type="button"
      data-testid="minimap-trigger"
      onMouseEnter={() => props.onHoverChange(true)}
    />
  ),
}));
vi.mock("@/features/canvas/ui/CanvasFpsMeter", () => ({ CanvasFpsMeter: () => null }));
vi.mock("@/features/canvas/snap-align/CanvasSnapAlignButton", () => ({
  CanvasSnapAlignButton: () => null,
}));
vi.mock("@/features/canvas/snap-align/SnapAlignGuides", () => ({ SnapAlignGuides: () => null }));

function renderCanvas() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Canvas />
    </QueryClientProvider>,
  );
}

describe("Canvas 小地图拖动期间保持挂载", () => {
  beforeEach(() => {
    capturedPanOptions = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("未固定时，拖动中划出小地图不会把它卸载；松手后才恢复自动隐藏", () => {
    vi.useFakeTimers();
    try {
      renderCanvas();

      // hover 触发按钮把小地图唤出来（默认非固定）。
      fireEvent.mouseEnter(screen.getByTestId("minimap-trigger"));
      expect(screen.getByTestId("minimap")).toBeTruthy();

      // 开始拖动，随后指针划出小地图触发 mouseleave。
      act(() => {
        capturedPanOptions?.onPanStart?.();
      });
      fireEvent.mouseLeave(screen.getByTestId("minimap"));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // hover 早已失效，但拖动还在进行 —— 小地图必须还在。
      expect(screen.queryByTestId("minimap")).not.toBeNull();

      // 松手在小地图外：先留够松手缓动收尾的时间，再收起。
      act(() => {
        capturedPanOptions?.onPanEnd?.(false);
      });
      expect(screen.queryByTestId("minimap")).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByTestId("minimap")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("松手时指针仍在小地图内则继续显示", () => {
    vi.useFakeTimers();
    try {
      renderCanvas();
      fireEvent.mouseEnter(screen.getByTestId("minimap-trigger"));
      act(() => {
        capturedPanOptions?.onPanStart?.();
      });
      fireEvent.mouseLeave(screen.getByTestId("minimap"));
      act(() => {
        capturedPanOptions?.onPanEnd?.(true);
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByTestId("minimap")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
