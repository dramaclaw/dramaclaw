// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Connection, Edge, FinalConnectionState, OnConnectStartParams } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import { Canvas } from "@/features/canvas/Canvas";

// Canvas 用 useQueryClient()(beats/episodeDetail 预取),渲染需包 QueryClientProvider。
function renderCanvas() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Canvas />
    </QueryClientProvider>,
  );
}

let capturedOnConnect: ((connection: Connection) => void) | null = null;
let capturedOnConnectStart:
  | ((event: MouseEvent | TouchEvent, params: OnConnectStartParams) => void)
  | null = null;
let capturedOnConnectEnd:
  | ((event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => void)
  | null = null;
let capturedReactFlowProps: Record<string, unknown> | null = null;

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("@xyflow/react", async () => {
  const actual =
    await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    ReactFlow: (props: {
      onConnect?: (connection: Connection) => void;
      onConnectStart?: (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => void;
      onConnectEnd?: (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => void;
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => {
      const { onConnect, onConnectStart, onConnectEnd, children } = props;
      capturedReactFlowProps = props;
      capturedOnConnect = onConnect ?? null;
      capturedOnConnectStart = onConnectStart ?? null;
      capturedOnConnectEnd = onConnectEnd ?? null;
      return <div data-testid="react-flow">{children}</div>;
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
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/api/skills", () => ({
  getSkillRegistry: vi.fn().mockResolvedValue([
    {
      id: "freezone.sketch_from_context",
      provider: "freezone_mainline",
      display_name: "Sketch From Context",
      description: "",
      inputs: [
        {
          role: "background",
          label: "Background",
          accepts: {
            node_types: [
              "imageGenNode",
              "imageNode",
              "uploadImageNode",
              "freezoneImageNode",
              "assetImageNode",
              "sceneNode",
              "identityNode",
              "propNode",
            ],
            media_kinds: ["image"],
            has_field: ["image_url"],
          },
          required: false,
          cardinality: "single",
        },
      ],
      outputs: [],
    },
    {
      id: "freezone.frame_from_context",
      provider: "freezone_mainline",
      display_name: "Frame From Context",
      description: "",
      inputs: [
        {
          role: "beat_context",
          label: "Shot Context",
          accepts: { node_types: ["beatContextNode"] },
          required: true,
          cardinality: "single",
        },
        {
          role: "identity",
          label: "Identity",
          accepts: {
            node_types: [
              "imageGenNode",
              "imageNode",
              "uploadImageNode",
              "freezoneImageNode",
              "assetImageNode",
              "sceneNode",
              "identityNode",
              "propNode",
            ],
            canonical_slot_kinds: ["identity", "portrait"],
            media_kinds: ["image"],
            has_field: ["image_url"],
          },
          required: false,
          cardinality: "multi",
        },
      ],
      outputs: [],
    },
  ]),
}));

vi.mock("@/features/canvas/nodes", () => ({
  nodeTypes: {},
}));

vi.mock("@/features/canvas/edges", () => ({
  edgeTypes: {},
}));

vi.mock("@/features/canvas/NodeSelectionMenu", () => ({
  NodeSelectionMenu: () => null,
}));

vi.mock("@/features/canvas/ui/SelectedNodeOverlay", () => ({
  SelectedNodeOverlay: () => null,
}));

vi.mock("@/features/canvas/ui/MultiSelectionToolbar", () => ({
  MultiSelectionToolbar: () => null,
}));

vi.mock("@/features/canvas/ui/MultiSelectionConnectButton", () => ({
  MultiSelectionConnectButton: () => null,
}));

vi.mock("@/features/canvas/ui/NodeSpawnPlusOverlay", () => ({
  NodeSpawnPlusOverlay: () => null,
}));

vi.mock("@/features/canvas/ui/CanvasContextMenu", () => ({
  CanvasContextMenu: () => null,
}));

vi.mock("@/features/canvas/ui/NodeToolDialog", () => ({
  NodeToolDialog: () => null,
}));

vi.mock("@/features/canvas/ui/ImageViewerModal", () => ({
  ImageViewerModal: () => null,
}));

vi.mock("@/features/canvas/ui/VideoViewerModal", () => ({
  VideoViewerModal: () => null,
}));

vi.mock("@/features/canvas/ui/CanvasZoomControl", () => ({
  CanvasZoomControl: () => null,
}));

vi.mock("@/features/canvas/ui/CanvasQuickActionBar", () => ({
  CanvasQuickActionBar: () => null,
}));

vi.mock("@/features/canvas/ui/CanvasMinimapButton", () => ({
  CanvasMinimapButton: () => null,
}));

vi.mock("@/features/canvas/ui/CanvasFpsMeter", () => ({
  CanvasFpsMeter: () => null,
}));

vi.mock("@/features/canvas/snap-align/CanvasSnapAlignButton", () => ({
  CanvasSnapAlignButton: () => null,
}));

vi.mock("@/features/canvas/snap-align/SnapAlignGuides", () => ({
  SnapAlignGuides: () => null,
}));

describe("Canvas manual skill connections", () => {
  beforeEach(() => {
    capturedOnConnect = null;
    capturedOnConnectStart = null;
    capturedOnConnectEnd = null;
    capturedReactFlowProps = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "image",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/image.png", aspectRatio: "1:1" },
        },
        {
          id: "skill",
          type: CANVAS_NODE_TYPES.skill,
          position: { x: 400, y: 0 },
          data: { skill_id: "freezone.sketch_from_context" },
        },
      ],
      [],
    );
  });

  it("configures ReactFlow loose connection mode so image and skill input handles can be dragged from either side", async () => {
    renderCanvas();

    await waitFor(() => expect(capturedReactFlowProps).toBeTruthy());

    expect(capturedReactFlowProps?.connectionMode).toBe("loose");
  });

  it("creates a role binding when dragging an uploaded image into a skill input", async () => {
    renderCanvas();

    await waitFor(() => expect(capturedOnConnect).toBeTruthy());

    act(() => {
      capturedOnConnect?.({
        source: "image",
        sourceHandle: "source",
        target: "skill",
        targetHandle: "background",
      });
    });

    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(useCanvasStore.getState().edges[0]).toMatchObject({
      source: "image",
      target: "skill",
      sourceHandle: "source",
      targetHandle: "background",
      data: {
        edgeKind: "role_binding",
        role: "background",
      },
    });
  });

  it("uses the exact skill input handle under the pointer when connect-end fallback creates the edge", async () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "context",
          type: CANVAS_NODE_TYPES.beatContext,
          position: { x: 0, y: 0 },
          data: {
            beat_context: {
              schema: "beat_context.v1",
              source: "standalone",
              visual_description: "{{YELLOW}} and {{GREEN}} enter",
              detected_identities: ["YELLOW", "GREEN"],
            },
          },
        },
        {
          id: "image",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/identity.png", aspectRatio: "1:1" },
        },
        {
          id: "skill",
          type: CANVAS_NODE_TYPES.skill,
          position: { x: 400, y: 0 },
          data: { skill_id: "freezone.frame_from_context" },
        },
      ],
      [
        {
          id: "e-context-skill-beat_context",
          source: "context",
          target: "skill",
          sourceHandle: "source",
          targetHandle: "beat_context",
          type: "disconnectableEdge",
          data: {
            edgeKind: "role_binding",
            role: "beat_context",
          },
        },
      ],
    );
    renderCanvas();

    await waitFor(() => expect(capturedOnConnectStart).toBeTruthy());
    await waitFor(() => expect(capturedOnConnectEnd).toBeTruthy());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const skillElement = document.createElement("div");
    skillElement.className = "react-flow__node";
    skillElement.dataset.id = "skill";
    const greenHandle = document.createElement("div");
    greenHandle.className = "react-flow__handle target";
    greenHandle.dataset.nodeid = "skill";
    greenHandle.dataset.handleid = "identity:GREEN";
    greenHandle.getBoundingClientRect = () =>
      ({
        left: 96,
        top: 96,
        width: 8,
        height: 8,
        right: 104,
        bottom: 104,
        x: 96,
        y: 96,
        toJSON: () => ({}),
      }) as DOMRect;
    skillElement.appendChild(greenHandle);
    document.body.appendChild(skillElement);
    const originalElementFromPoint = document.elementFromPoint;
    const elementFromPoint = vi.fn().mockReturnValue(greenHandle);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint,
    });

    try {
      act(() => {
        capturedOnConnectStart?.(
          { clientX: 0, clientY: 0, target: null } as unknown as MouseEvent,
          { nodeId: "image", handleId: "source", handleType: "source" },
        );
      });
      await waitFor(() => expect(capturedReactFlowProps).toBeTruthy());
      act(() => {
        capturedOnConnectEnd?.(
          { clientX: 100, clientY: 100, target: greenHandle } as unknown as MouseEvent,
          { isValid: false } as FinalConnectionState,
        );
      });
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint,
      });
      skillElement.remove();
    }

    const identityEdge = useCanvasStore
      .getState()
      .edges.find((edge) => edge.source === "image");
    expect(identityEdge).toMatchObject({
      source: "image",
      target: "skill",
      sourceHandle: "source",
      targetHandle: "identity:GREEN",
      data: {
        edgeKind: "role_binding",
        role: "identity",
        reference_target: { kind: "identity", identity_id: "GREEN" },
      },
    });
  });
});

// 拖线时的落点校验(isValidConnection)和松手时的建边判定(onConnect)是两处独立代码,
// 一旦口径不一致,用户看到的是「拖过去高亮成合法、一松手什么也没有」。这里不去断言
// 某个具体规则,而是断言这两处**对同一对节点给出同一个答案** —— 规则以后怎么改都行,
// 两边一起改就行。
describe("Canvas 拖线落点校验与建边判定对齐", () => {
  const NODES = [
    { id: "text", type: CANVAS_NODE_TYPES.textAnnotation, data: { text: "旁白" } },
    { id: "audio", type: CANVAS_NODE_TYPES.audio, data: { audioUrl: "/a.mp3" } },
    { id: "image", type: CANVAS_NODE_TYPES.imageGen, data: { imageUrl: "/i.png" } },
    { id: "video", type: CANVAS_NODE_TYPES.video, data: { videoUrl: "/v.mp4" } },
  ];

  // 至少要覆盖到一对「建边规则放行、但不开放手工创建」的边(视频→音频那条溯源边),
  // 否则两处都用宽松规则也能让测试全绿。
  const PAIRS: { source: string; target: string; expected: boolean }[] = [
    { source: "text", target: "audio", expected: true },
    { source: "audio", target: "video", expected: true },
    { source: "audio", target: "image", expected: false },
    { source: "video", target: "audio", expected: false },
  ];

  function resetCanvas() {
    useCanvasStore.getState().setCanvasData(
      NODES.map((node, index) => ({
        ...node,
        position: { x: index * 400, y: 0 },
      })),
      [],
    );
  }

  beforeEach(() => {
    capturedOnConnect = null;
    capturedReactFlowProps = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    resetCanvas();
  });

  it("两处判定对每一对节点给出同一个答案", async () => {
    renderCanvas();
    await waitFor(() => expect(capturedOnConnect).toBeTruthy());

    for (const pair of PAIRS) {
      act(() => {
        resetCanvas();
      });
      const connection: Connection = {
        source: pair.source,
        sourceHandle: "source",
        target: pair.target,
        targetHandle: "target",
      };

      const isValidConnection = capturedReactFlowProps?.isValidConnection as
        | ((connection: Connection | Edge) => boolean)
        | undefined;
      const highlightedAsValid = isValidConnection?.(connection);

      act(() => {
        capturedOnConnect?.(connection);
      });
      const edgeCreated = useCanvasStore
        .getState()
        .edges.some((edge) => edge.source === pair.source && edge.target === pair.target);

      expect({ ...pair, highlightedAsValid, edgeCreated }).toEqual({
        ...pair,
        highlightedAsValid: pair.expected,
        edgeCreated: pair.expected,
      });
    }
  });
});
