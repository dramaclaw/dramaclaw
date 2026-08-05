// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 「换模型断掉超限素材边」这条 effect 只能被**用户换模型**触发，绝不能被
// 目录接口的异步 hydration 触发。
//
// useFreezoneVideoModels 在 pending 期间返回的不是空数组，而是硬编码的
// VIDEO_MODELS。节点上持久化的自定义模型在那一刻解析不出来，videoModelForNode
// 会落到兜底列表首项；目录回来后又变回真正选中的那个。若拿这个跳变当「换了模型」，
// 用户只是打开一张旧画布就会被删边并落盘 —— 不可逆的画布数据丢失。
//
// 两条一起锁：hydration 不删边（回归），真换模型仍要删边（防止这道闸把功能整个关掉）。
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Connection } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import { Canvas } from "@/features/canvas/Canvas";
import { VIDEO_MODELS } from "@/features/canvas/ui/ProviderModelPicker";

/** 后台配的自定义模型：只吃 1 个视频素材，且不在兜底列表里。 */
const CUSTOM_MODEL = {
  id: "studio-custom-v1",
  providerId: "seedance",
  apiModel: "studio-custom-v1",
  label: "Studio Custom",
  referenceVideoMax: 1,
};

const OTHER_MODEL = {
  id: "studio-custom-v2",
  providerId: "seedance",
  apiModel: "studio-custom-v2",
  label: "Studio Custom 2",
  referenceVideoMax: 1,
};

let videoModelsState: {
  models: unknown[];
  isLoading: boolean;
  isFallback: boolean;
  error: Error | null;
} = { models: VIDEO_MODELS, isLoading: true, isFallback: true, error: null };

vi.mock("@/features/canvas/hooks/useFreezoneVideoModels", () => ({
  useFreezoneVideoModels: () => videoModelsState,
  prefetchFreezoneVideoModels: () => {},
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let capturedOnConnect: ((connection: Connection) => void) | null = null;

vi.mock("@xyflow/react", async () => {
  const actual =
    await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    ReactFlow: (props: {
      onConnect?: (connection: Connection) => void;
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => {
      capturedOnConnect = props.onConnect ?? null;
      return <div data-testid="react-flow">{props.children}</div>;
    },
    Background: () => null,
    MiniMap: () => null,
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
vi.mock("@/features/canvas/ui/MultiSelectionConnectButton", () => ({ MultiSelectionConnectButton: () => null }));
vi.mock("@/features/canvas/ui/NodeSpawnPlusOverlay", () => ({ NodeSpawnPlusOverlay: () => null }));
vi.mock("@/features/canvas/ui/CanvasContextMenu", () => ({ CanvasContextMenu: () => null }));
vi.mock("@/features/canvas/ui/NodeToolDialog", () => ({ NodeToolDialog: () => null }));
vi.mock("@/features/canvas/ui/ImageViewerModal", () => ({ ImageViewerModal: () => null }));
vi.mock("@/features/canvas/ui/VideoViewerModal", () => ({ VideoViewerModal: () => null }));
vi.mock("@/features/canvas/ui/CanvasZoomControl", () => ({ CanvasZoomControl: () => null }));
vi.mock("@/features/canvas/ui/CanvasQuickActionBar", () => ({ CanvasQuickActionBar: () => null }));
vi.mock("@/features/canvas/ui/CanvasMinimapButton", () => ({ CanvasMinimapButton: () => null }));
vi.mock("@/features/canvas/ui/CanvasFpsMeter", () => ({ CanvasFpsMeter: () => null }));
vi.mock("@/features/canvas/snap-align/CanvasSnapAlignButton", () => ({ CanvasSnapAlignButton: () => null }));
vi.mock("@/features/canvas/snap-align/SnapAlignGuides", () => ({ SnapAlignGuides: () => null }));

const TARGET = "target-video";

function renderCanvas() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // 每次都新建元素（复用同一个元素对象会命中 React 的 bailout，子树根本不重渲染），
  // 但共用同一个 QueryClient —— 模拟「组件没卸载，只是 hook 返回值变了」。
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <Canvas />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, rerenderSame: () => view.rerender(tree()) };
}

/** 一个持久化了自定义模型、且已连了 2 个视频素材（超出该模型 1 个上限）的旧画布。 */
function seedLegacyCanvas() {
  const sources = [0, 1].map((index) => ({
    id: `src-${index}`,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: index * 200 },
    data: { videoUrl: `/v${index}.mp4` },
  }));
  useCanvasStore.getState().setCanvasData(
    [
      ...sources,
      {
        id: TARGET,
        type: CANVAS_NODE_TYPES.video,
        position: { x: 600, y: 0 },
        data: { model: CUSTOM_MODEL.id },
      },
    ],
    sources.map((node) => ({
      id: `e-${node.id}`,
      source: node.id,
      target: TARGET,
      sourceHandle: "source",
      targetHandle: "target",
    })),
  );
}

const upstreamEdgeCount = () =>
  useCanvasStore.getState().edges.filter((edge) => edge.target === TARGET).length;

beforeEach(() => {
  capturedOnConnect = null;
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  videoModelsState = {
    models: VIDEO_MODELS,
    isLoading: true,
    isFallback: true,
    error: null,
  };
});

describe("视频模型目录 hydration 不得被当成用户换模型", () => {
  it("loading→ready 期间模型 id 从兜底首项变成持久化模型，既有超限边必须原封不动", async () => {
    seedLegacyCanvas();
    const view = renderCanvas();
    await waitFor(() => expect(capturedOnConnect).toBeTruthy());
    // 加载中：videoModelForNode 解析不出 studio-custom-v1，落到 VIDEO_MODELS[0]。
    expect(upstreamEdgeCount()).toBe(2);

    // 目录回来了。用户全程没碰过模型选择器。
    await act(async () => {
      videoModelsState = {
        models: [CUSTOM_MODEL, OTHER_MODEL],
        isLoading: false,
        isFallback: false,
        error: null,
      };
      view.rerenderSame();
    });

    expect(upstreamEdgeCount()).toBe(2);
    view.unmount();
  });

  it("目录就绪后用户真的换模型，仍然断掉超出新上限的边", async () => {
    seedLegacyCanvas();
    videoModelsState = {
      models: [CUSTOM_MODEL, OTHER_MODEL],
      isLoading: false,
      isFallback: false,
      error: null,
    };
    const view = renderCanvas();
    await waitFor(() => expect(capturedOnConnect).toBeTruthy());
    expect(upstreamEdgeCount()).toBe(2);

    await act(async () => {
      useCanvasStore.getState().updateNodeData(TARGET, { model: OTHER_MODEL.id });
    });

    // OTHER_MODEL 同样只吃 1 个视频 —— 第 2 条边被断开。
    await waitFor(() => expect(upstreamEdgeCount()).toBe(1));
    view.unmount();
  });
});
