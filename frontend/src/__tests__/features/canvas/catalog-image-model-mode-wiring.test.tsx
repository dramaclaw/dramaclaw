// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 目录参数按 `modes` 过滤：`MediaModelParameterChip` 拿不到模式时，声明了 modes 的
// 参数**一个都不渲染**（整个控件 return null），用户在 UI 上根本看不到、也就无从
// 设置。
//
// 三个图片宿主里只有 ImageEditNode 有模式选择器，而它的 `data.generationMode` 在
// 用户没手动选过之前是 undefined；ImageGenNode / StoryboardGenNode 的节点数据里
// 压根没有这个字段。所以「把 `data.generationMode` 直接递给控件」等于三处全都是
// undefined —— 控件永远藏参数。这里锁住的是「递给控件的必须是推导后的模式」。
//
// 本文件取代了原来 readFileSync + toContain 的版本：那种写法只要字符串还在源文件
// 里就通过，既不验证推导出的值对不对，也不验证控件真的显示出来了。这里改成渲染断言
// ——参数只声明在某一个模式下，控件出现/消失就是「推导值等于那个模式」的证据。
//
// 提交侧的模式由 `catalog-image-model-params.test.ts` 覆盖到 ops payload；这条只
// 盯住渲染侧的接线，因为控件不显示的话提交侧再对也没有值可提交。
import { render, renderHook, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaModelParameterDefinition } from "@/api/ops";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { ImageEditNode } from "@/features/canvas/nodes/ImageEditNode";
import { StoryboardGenNode } from "@/features/canvas/nodes/StoryboardGenNode";
import { useImageGenerationForm } from "@/features/canvas/nodes/shared/useImageGenerationForm";
import { MediaModelParameterChip } from "@/features/canvas/ui/MediaModelParameterChip";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === "string" ? fallback : key,
    i18n: { language: "zh" },
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/generation-credit-cost")>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));

vi.mock("@/lib/url-params", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: "demo-project", canvas: "default" }),
}));

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneImageModels: vi.fn(async () => [
    {
      id: "huimeng/test-image",
      providerId: "huimeng",
      apiModel: "test_image_api",
      label: "测试模型",
    },
  ]),
  listFreezoneStyleTemplates: vi.fn(async () => []),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
}));

// 每个用例把「目录声明了哪些参数」换掉，用参数各自的 modes 当探针。
const catalog = vi.hoisted(() => ({
  parameters: [] as unknown[],
}));

vi.mock("@/features/canvas/domain/catalogImageModels", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/canvas/domain/catalogImageModels")>();
  const buildModel = () =>
    actual.toImageModelDefinition({
      id: "huimeng/test-image",
      providerId: "huimeng",
      apiModel: "test_image_api",
      label: "测试模型",
      request: {
        parameters: catalog.parameters,
      } as never,
    });
  return {
    ...actual,
    useCatalogImageModels: () => {
      const model = buildModel();
      return {
        models: [model],
        getModel: () => model,
        isLoading: false,
        isEmpty: false,
      };
    },
  };
});

/** 只在 `mode` 这一个模式下可见的参数。控件出现 == 推导出的模式就是它。 */
function paramForMode(mode: string): MediaModelParameterDefinition {
  return {
    key: `p_${mode}`,
    label: `参数 ${mode}`,
    control: "number",
    modes: [mode],
  } as unknown as MediaModelParameterDefinition;
}

/** React Flow 会把这些必填 prop 一并传给节点组件，测试里补齐即可。 */
const REACT_FLOW_NODE_PROPS = {
  type: "",
  draggable: true,
  selectable: true,
  deletable: true,
  dragging: false,
  zIndex: 0,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
} as const;

/** `MediaModelParameterChip` 的触发钮只有一个图标，用 title 定位。 */
function paramsChip(): HTMLElement | null {
  return document.querySelector('button[title="canvas.modelParams.title"]');
}

function imageGenNode(id: string, data: Record<string, unknown> = {}): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: { prompt: "一只猫", modelId: "huimeng/test-image", ...data },
  } as CanvasNode;
}

function uploadNode(id: string, url: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 0, y: 0 },
    data: { imageUrl: url },
  } as CanvasNode;
}

beforeEach(() => {
  catalog.parameters = [];
  useCanvasStore.getState().setCanvasData([], []);
});

describe("模式缺失时模型参数控件的后果", () => {
  it("mode 为 undefined 时，声明了 modes 的参数一个都不渲染", () => {
    const { container } = render(
      <MediaModelParameterChip parameters={[paramForMode("image_to_image")]} onChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("拿到匹配的 mode 就渲染出来", () => {
    render(
      <MediaModelParameterChip
        parameters={[paramForMode("image_to_image")]}
        mode="image_to_image"
        onChange={vi.fn()}
      />,
    );
    expect(paramsChip()).not.toBeNull();
  });
});

describe("ImageGenNode（共享生成表单）递出去的模式", () => {
  it("没有参考图时推导为文生图，而不是留空", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode("img-1")], []);

    const { result } = renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(result.current.formProps.modelParamsMode).toBe("text_to_image");
    });
  });

  it("有上游参考图时推导为图生图", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [imageGenNode("img-1"), uploadNode("src-1", "/static/ref.png")],
        [{ id: "e1", source: "src-1", target: "img-1" }],
      );

    const { result } = renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(result.current.formProps.modelParamsMode).toBe("image_to_image");
    });
  });

  it("节点数据里没有 generationMode 字段时也永远有值", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([imageGenNode("img-1", { generationMode: undefined })], []);

    const { result } = renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(result.current.formProps.modelParamsMode).toBeTruthy();
    });
  });
});

describe("ImageEditNode 递给模型参数控件的模式", () => {
  function renderNode(data: Record<string, unknown>) {
    return render(
      <ReactFlowProvider>
        {/* 节点组件只吃 React Flow 传的这几个 prop */}
        <ImageEditNode
          {...REACT_FLOW_NODE_PROPS}
          id="edit-1"
          data={data as never}
          selected
          width={520}
          height={520}
        />
      </ReactFlowProvider>,
    );
  }

  it("用户没手动选过模式、也没有上游图时，文生图参数依然可见", () => {
    catalog.parameters = [paramForMode("text_to_image")];
    const node = {
      id: "edit-1",
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { model: "huimeng/test-image" },
    } as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);

    renderNode(node.data as Record<string, unknown>);

    // 递裸 data.generationMode（undefined）的话这里就是 null。
    expect(paramsChip()).not.toBeNull();
  });

  it("有上游图时推导为全能参考，只在该模式下声明的参数才出现", () => {
    catalog.parameters = [paramForMode("all_reference")];
    const node = {
      id: "edit-1",
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { model: "huimeng/test-image" },
    } as CanvasNode;
    useCanvasStore
      .getState()
      .setCanvasData(
        [node, uploadNode("src-1", "/static/ref.png")],
        [{ id: "e1", source: "src-1", target: "edit-1" }],
      );

    renderNode(node.data as Record<string, unknown>);

    expect(paramsChip()).not.toBeNull();
  });

  it("没有上游图时，全能参考专属参数不该出现（证明推导值不是随便给的）", () => {
    catalog.parameters = [paramForMode("all_reference")];
    const node = {
      id: "edit-1",
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { model: "huimeng/test-image" },
    } as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);

    renderNode(node.data as Record<string, unknown>);

    expect(paramsChip()).toBeNull();
  });

  it("用户手动选过模式时以他选的为准", () => {
    catalog.parameters = [paramForMode("all_reference")];
    const node = {
      id: "edit-1",
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { model: "huimeng/test-image", generationMode: "all_reference" },
    } as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);

    renderNode(node.data as Record<string, unknown>);

    expect(paramsChip()).not.toBeNull();
  });
});

describe("StoryboardGenNode 递给模型参数控件的模式", () => {
  function seedAndRender(params: MediaModelParameterDefinition[]) {
    catalog.parameters = params;
    const node = {
      id: "sb-1",
      type: CANVAS_NODE_TYPES.storyboardGen,
      position: { x: 0, y: 0 },
      data: { model: "huimeng/test-image", frames: [] },
    } as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);
    render(
      <ReactFlowProvider>
        <StoryboardGenNode
          {...REACT_FLOW_NODE_PROPS}
          id="sb-1"
          data={node.data as never}
          selected
          width={520}
          height={520}
        />
      </ReactFlowProvider>,
    );
  }

  it("恒为图生图（宫格图总是作为参考图提交），不看节点数据", () => {
    seedAndRender([paramForMode("image_to_image")]);
    expect(paramsChip()).not.toBeNull();
  });

  it("文生图专属参数在分镜生成节点上永远不出现", () => {
    seedAndRender([paramForMode("text_to_image")]);
    expect(paramsChip()).toBeNull();
  });
});
