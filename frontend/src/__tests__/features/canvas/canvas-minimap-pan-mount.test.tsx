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
type Viewport = { x: number; y: number; zoom: number };
type PanOptions = {
  onPanStart?: () => void;
  onPanEnd?: (pointerInsideMinimap: boolean) => void;
  onViewportSettled?: (viewport: Viewport) => void;
};
let capturedPanOptions: PanOptions | null = null;

vi.mock("@/features/canvas/hooks/useSmoothMinimapPan", () => ({
  useSmoothMinimapPan: (options: PanOptions) => {
    capturedPanOptions = options;
  },
}));

// onMoveEnd 要能单独触发：小地图缓动期间 ReactFlow 会**每帧**跑一遍完整的
// move 生命周期，这里要断言那些帧不会逐个提交视口。
let capturedFlowProps: {
  onMoveEnd?: (event: unknown, viewport: Viewport) => void;
} | null = null;

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    ReactFlow: (props: {
      children?: React.ReactNode;
      onMoveEnd?: (event: unknown, viewport: Viewport) => void;
    }) => {
      capturedFlowProps = props;
      return <div data-testid="react-flow">{props.children}</div>;
    },
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
    capturedFlowProps = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    useCanvasStore.getState().setCanvasData([], []);
    useCanvasStore.setState({ currentViewport: { x: 0, y: 0, zoom: 1 } });
  });

  it("未固定时，拖动中划出小地图不会把它卸载；结束后才恢复自动隐藏", () => {
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

      // onPanEnd 已经是 hook 保证的「松手且缓动收敛」，这里不必再赌一个固定延时
      // （收敛耗时随剩余距离变化，180ms 盖不住，反而会把缓动掐断）。
      act(() => {
        capturedPanOptions?.onPanEnd?.(false);
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

  it("缓动期间 onMoveEnd 不逐帧提交视口，收敛时才提交一次", () => {
    renderCanvas();
    fireEvent.mouseEnter(screen.getByTestId("minimap-trigger"));

    act(() => {
      capturedPanOptions?.onPanStart?.();
    });

    // instance.setViewport 每次都会走完整的 onMoveStart→onMove→onMoveEnd，而
    // 结束事件只有 panOnScroll 才有 150ms 合并；用户关掉「触控板平移」后
    // panOnScroll=false，缓动的每一帧都会落到这里。
    act(() => {
      capturedFlowProps?.onMoveEnd?.(null, { x: -30, y: 0, zoom: 1 });
      capturedFlowProps?.onMoveEnd?.(null, { x: -60, y: 0, zoom: 1 });
      capturedFlowProps?.onMoveEnd?.(null, { x: -90, y: 0, zoom: 1 });
    });
    expect(useCanvasStore.getState().currentViewport).toEqual({ x: 0, y: 0, zoom: 1 });

    act(() => {
      capturedPanOptions?.onViewportSettled?.({ x: -100, y: 0, zoom: 1 });
    });
    expect(useCanvasStore.getState().currentViewport).toEqual({ x: -100, y: 0, zoom: 1 });
  });

  it("不是小地图拖动时，onMoveEnd 照常提交视口", () => {
    renderCanvas();
    act(() => {
      capturedFlowProps?.onMoveEnd?.(null, { x: -42, y: 7, zoom: 1 });
    });
    expect(useCanvasStore.getState().currentViewport).toEqual({ x: -42, y: 7, zoom: 1 });
  });
});
