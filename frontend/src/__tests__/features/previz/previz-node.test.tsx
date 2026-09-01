// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES, type PrevizNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  getMenuNodeDefinitions,
  getUpstreamSpawnTypes,
} from "@/features/canvas/domain/nodeRegistry";
import { PrevizNode } from "@/features/canvas/nodes/PrevizNode";
import { nodeTypes } from "@/features/canvas/nodes";
import { PREVIZ_SCHEMA_VERSION, createDefaultScene } from "@/features/previz/domain/scene";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
  useUpdateNodeInternals: () => () => {},
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));

// 编辑器是 lazy 的且会拉 three；节点测试只关心卡片和开关接线。
vi.mock("@/features/previz/PrevizEditor", () => ({
  PrevizEditor: ({ open }: { open: boolean }) =>
    open ? <div data-testid="previz-editor-open" /> : null,
}));

beforeAll(() => {
  // jsdom 29 不提供 ResizeObserver，而卡片头部 NodeHeader 用它测标题溢出。
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function renderNode(data: Partial<PrevizNodeData> = {}) {
  const nodeId = useCanvasStore
    .getState()
    .addNode(CANVAS_NODE_TYPES.previz, { x: 0, y: 0 }, data);
  const node = useCanvasStore.getState().nodes.find((entry) => entry.id === nodeId);
  // PrevizNodeProps 是 `NodeProps & {…}`（仓库所有节点组件的写法），NodeProps 里
  // 这一串字段都是必填的。照实给出真实值，不用 as unknown as 糊过去。
  render(
    <PrevizNode
      id={nodeId}
      type="previzNode"
      data={node?.data as PrevizNodeData}
      selected={false}
      draggable
      selectable
      deletable
      dragging={false}
      zIndex={0}
      isConnectable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
    />,
  );
  return nodeId;
}

describe("PrevizNode", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("shows the empty-state hint before a scene exists", () => {
    renderNode();

    expect(screen.getByText("previz.node.empty")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "previz.node.open" })).toBeEnabled();
  });

  it("shows the stored summary once a scene has been saved", () => {
    renderNode({ scene: createDefaultScene(), summary: { objectCount: 4, durationFrames: 240 } });

    expect(screen.getByText("previz.node.summary:4,240")).toBeInTheDocument();
  });

  it("refuses to open a scene written by a newer version", () => {
    renderNode({ scene: { schemaVersion: PREVIZ_SCHEMA_VERSION + 1 } as never });

    expect(screen.getByText("previz.node.versionTooNew")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "previz.node.open" })).toBeDisabled();
  });

  it("opens the editor and writes the flushed scene back to node.data", async () => {
    const user = userEvent.setup();
    const nodeId = renderNode();

    await user.click(screen.getByRole("button", { name: "previz.node.open" }));
    // 编辑器是 React.lazy 的：即便模块被 mock 掉，Suspense 也要多等一个微任务才
    // 换下 fallback，同步的 getByTestId 必然取不到。
    expect(await screen.findByTestId("previz-editor-open")).toBeInTheDocument();

    const scene = createDefaultScene();
    scene.settings.durationFrames = 300;
    useCanvasStore.getState().updateNodeData(nodeId, {
      scene,
      summary: { objectCount: 0, durationFrames: 300 },
    });

    const stored = useCanvasStore.getState().nodes.find((entry) => entry.id === nodeId)
      ?.data as PrevizNodeData;
    expect(stored.scene?.settings.durationFrames).toBe(300);
  });
});

// `nodeTypes` 的类型是 `Record<string, ComponentType>` 而不是
// `Record<CanvasNodeType, …>`，所以少挂一个节点组件 tsc 永远不会报——注册表里能拖出
// 来、React Flow 却渲染不出来的节点，只有这条棘轮能拦住。对所有节点类型生效。
describe("canvas node registration ratchet", () => {
  it("gives every menu node type a component in nodeTypes", () => {
    const missing = getMenuNodeDefinitions()
      .map((definition) => definition.type)
      .filter((type) => !(type in nodeTypes));

    expect(missing).toEqual([]);
  });
});

// P0 的预演台不读任何上游：场景全部在编辑器里手工搭建。缺条目会回落到 connectMenu
// 默认列表（实测给出 skill / threeDWorld / previz 自己），那是仓库反复称的「骗人的
// 线」。显式空数组让 Canvas.tsx 的 `allowedTypes.length === 0` 分支直接不弹菜单。
describe("previz upstream spawn", () => {
  it("offers no upstream node types from the previz target handle", () => {
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.previz)).toEqual([]);
  });
});
