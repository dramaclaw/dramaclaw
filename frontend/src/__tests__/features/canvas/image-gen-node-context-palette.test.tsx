// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 调色盘按钮与提示词插入已随生成表单 UI 一起抽到 `ImageGenerationForm`（可独立挂载
// 于 React Flow 之外），ImageGenNode 本身只渲染该组件。这条锁住的是**用户能走完
// 的那条路**：面板上出现调色盘 → 展开看到条目 → 点一下把标准措辞写进提示词。
//
// 本文件取代了原来 readFileSync + toContain 的版本。那种写法只要 `<NodeContext
// PromptPaletteButton` / `insertTextAtCursor(` 这些字符串还在源文件里就通过——按钮
// 因 palette 为空而不渲染、ref 没接上导致插入是空操作、传错 nodeId 拿到别的节点的
// 上下文，它一个都发现不了。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MainlineContext } from "@/features/freezone/context/mainlineContext";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { ImageGenerationForm } from "@/features/canvas/nodes/shared/ImageGenerationForm";
import { useImageGenerationForm } from "@/features/canvas/nodes/shared/useImageGenerationForm";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// 调色盘按钮的文案走 i18n key，这里让 t 回落到 key，便于按 aria-label 定位。
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

const PALETTE_BUTTON_LABEL = "node.imageGen.contextPalette.button";

function beatContext(overrides: Partial<MainlineContext> = {}): MainlineContext {
  return {
    kind: "beat",
    projectId: "demo-project",
    episode: 1,
    beat: 2,
    label: "EP1 / Beat 2",
    sketchColors: { "identity:面馆男青年_青年时期": "#FF00FF" },
    propMarkerColors: { "prop:纸箱": "#B71C1C" },
    ...overrides,
  };
}

/** 宿主：跟 ImageGenNode 一样「hook 出 formProps → 展开给表单」，不带 React Flow。 */
function Host({ nodeId }: { nodeId: string }) {
  const { formProps } = useImageGenerationForm(nodeId);
  return (
    <ImageGenerationForm
      {...formProps}
      onStylePickerOpenChange={() => {}}
      onOpenAssetLibrary={() => {}}
    />
  );
}

function imageGenNode(id: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: { prompt: "", modelId: "huimeng/test-image" },
  } as CanvasNode;
}

function beatContextNode(id: string, ctx: MainlineContext = beatContext()): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.beatContext,
    position: { x: 0, y: 0 },
    data: { mainline_context: [ctx] },
  } as CanvasNode;
}

function paletteButton() {
  return screen.queryByRole("button", { name: PALETTE_BUTTON_LABEL });
}

describe("ImageGenNode 的上下文调色盘", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("画布上有节拍上下文时，面板里出现调色盘按钮", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([imageGenNode("img-1"), beatContextNode("beat-1")], []);

    render(<Host nodeId="img-1" />);

    await waitFor(() => {
      expect(paletteButton()).not.toBeNull();
    });
  });

  it("没有节拍上下文时仍可用，只是条目退化成匿名颜色", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode("img-1")], []);

    render(<Host nodeId="img-1" />);

    await waitFor(() => {
      expect(paletteButton()).not.toBeNull();
    });
    fireEvent.click(paletteButton()!);

    // 匿名条目没有人物名，只有色块；插入的措辞相应地不带「」。
    const swatch = await screen.findByTitle("#FF00FF");
    fireEvent.click(swatch);

    await waitFor(() => {
      const editor = document.querySelector<HTMLElement>("[contenteditable='true']");
      expect(editor?.textContent ?? "").toContain("#FF00FF 标记的人物");
    });
    const editor = document.querySelector<HTMLElement>("[contenteditable='true']");
    expect(editor?.textContent ?? "").not.toContain("「");
  });

  it("画布上有多个节拍上下文时，只认自己连着的那一个", async () => {
    // 两个以上节拍上下文 → 「全画布唯一」的兜底不生效，必须靠 nodeId 沿边找上游。
    // 传错 nodeId（比如写死成别的 id）在这里就会拿不到具名条目。
    useCanvasStore.getState().setCanvasData(
      [
        imageGenNode("img-1"),
        beatContextNode("beat-1"),
        beatContextNode(
          "beat-2",
          beatContext({
            beat: 7,
            sketchColors: { "identity:天台女配_中年时期": "#00FFCC" },
            propMarkerColors: {},
          }),
        ),
      ],
      [{ id: "e1", source: "beat-1", target: "img-1", data: { propagates: true } }],
    );

    render(<Host nodeId="img-1" />);

    await waitFor(() => {
      expect(paletteButton()).not.toBeNull();
    });
    fireEvent.click(paletteButton()!);

    expect(await screen.findByText(/面馆男青年_青年时期/)).toBeInTheDocument();
    expect(screen.queryByText(/天台女配_中年时期/)).toBeNull();
  });

  it("展开后点条目，把标准措辞插进提示词编辑器", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([imageGenNode("img-1"), beatContextNode("beat-1")], []);

    render(<Host nodeId="img-1" />);

    await waitFor(() => {
      expect(paletteButton()).not.toBeNull();
    });
    fireEvent.click(paletteButton()!);

    // 具名条目按 sketchColors 解析出人物名。
    const entry = await screen.findByText(/面馆男青年_青年时期/);
    fireEvent.click(entry);

    // 插入的是 contextPromptPaletteInsertionText 的措辞：颜色 + 「人物名」。
    await waitFor(() => {
      const editor = document.querySelector<HTMLElement>("[contenteditable='true']");
      expect(editor?.textContent ?? "").toContain(
        "#FF00FF 标记的人物「面馆男青年_青年时期」",
      );
    });
  });
});
