// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { CANVAS_NODE_TYPES, type PrevizNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  getMenuNodeDefinitions,
  getUpstreamSpawnTypes,
} from "@/features/canvas/domain/nodeRegistry";
import { PrevizNode } from "@/features/canvas/nodes/PrevizNode";
import { nodeTypes } from "@/features/canvas/nodes";
import { createPrevizObject } from "@/features/previz/domain/objects";
import {
  PREVIZ_SCHEMA_VERSION,
  createDefaultScene,
  type PrevizScene,
} from "@/features/previz/domain/scene";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

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
  // `nodes/index.ts` 把 ThreeDWorldNode 一起拉进来，它链到 `src/i18n/index.ts`，
  // 而那个模块在模块作用域就 `.use(initReactI18next)`。整份 mock 掉 react-i18next
  // 就必须连这个导出一起给，否则整个套件在收集阶段就炸（症状是「0 test」，
  // 跟本文件的断言毫无关系）。这里只要一个不做事的 i18next 插件对象。
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// 编辑器是 lazy 的且会拉 three；节点测试只关心卡片和开关接线。
// `onFlush` 借这个桩子交回测试：自动保存之后它每停手一次就来一发，这一层怎么
// 应付「存不下」的重复失败是节点自己的事，用不着把真编辑器拖进来。
// 用 `vi.hoisted`：`vi.mock` 的工厂会被提升到 import 之前，直接引模块级的 let
// 会撞 TDZ。
const editorStub = vi.hoisted(() => ({ flush: null as ((scene: never) => void) | null }));

vi.mock("@/features/previz/PrevizEditor", () => ({
  PrevizEditor: ({ open, onFlush }: { open: boolean; onFlush: (scene: never) => void }) => {
    editorStub.flush = onFlush;
    return open ? <div data-testid="previz-editor-open" /> : null;
  },
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
    // toast 是模块级的桩子，不清的话第二条计数用例会把上一条留下的调用一起数进来。
    vi.clearAllMocks();
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

  it("complains once, not once per autosave, when the scene is too big to store", async () => {
    const user = userEvent.setup();
    renderNode();
    await user.click(screen.getByRole("button", { name: "previz.node.open" }));
    expect(await screen.findByTestId("previz-editor-open")).toBeInTheDocument();

    // 超限是个粘性状态：一旦存不下，之后每一次自动保存都会失败。自动保存把
    // `onFlush` 变成「每停手一次来一发」，不加闸的话用户每动一下就吃一条错误
    // toast，堆起来糊满屏幕、还挡住工具栏——而他要做的（删对象）恰恰得看得见
    // 界面才做得了。
    const before = useCanvasStore.getState().nodes[0]?.data;
    const flush = editorStub.flush!;
    act(() => flush(tooLargeScene() as never));
    act(() => flush(tooLargeScene() as never));
    act(() => flush(tooLargeScene() as never));

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("previz.editor.sceneTooLarge");
    // 闭嘴不等于偷偷存下去：超限载荷进了整画布 PUT，canvasSync 收到 413 会永久停掉
    // 自动保存，炸的是整张画布而不只是这个节点。`updateNodeData` 每次都换新对象，
    // 引用没动就是一次都没写。
    expect(useCanvasStore.getState().nodes[0]?.data).toBe(before);
  });

  it("complains again after a save has succeeded in between", async () => {
    const user = userEvent.setup();
    renderNode();
    await user.click(screen.getByRole("button", { name: "previz.node.open" }));
    expect(await screen.findByTestId("previz-editor-open")).toBeInTheDocument();

    const flush = editorStub.flush!;
    act(() => flush(tooLargeScene() as never));
    // 删掉几个对象、存下去了：闸就该复位。否则用户瘦身成功之后再撑爆一次，
    // 这个节点从此再也不吭声，界面上看起来一切正常，实际上什么都没存。
    act(() => flush(createDefaultScene() as never));
    act(() => flush(tooLargeScene() as never));

    expect(toast.error).toHaveBeenCalledTimes(2);
  });
});

/** 造一个必然过 1 MB 转存阈值的场景：40 个对象、每个名字 30 KB。 */
function tooLargeScene(): PrevizScene {
  const scene = createDefaultScene();
  for (let index = 0; index < 40; index += 1) {
    const object = createPrevizObject("character", scene.objects);
    scene.objects.push({ ...object, name: "x".repeat(30_000) });
  }
  return scene;
}

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
