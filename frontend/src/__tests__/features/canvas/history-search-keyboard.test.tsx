// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

const translations: Record<string, string> = {
  "canvas.history.tabs.image": "图片历史",
  "canvas.history.tabs.video": "视频历史",
  "canvas.history.tabs.audio": "音频历史",
  "canvas.history.tabs.world": "世界历史",
  "canvas.history.noMatch": "没有匹配的历史资产",
  "canvas.history.noMatchOtherTabs": "当前分类没有匹配项，试试{{tabs}}",
};

const enTranslations: Record<string, string> = {
  "canvas.history.tabs.image": "Images",
  "canvas.history.tabs.video": "Videos",
  "canvas.history.tabs.audio": "Audio",
  "canvas.history.tabs.world": "World Models",
  "canvas.history.noMatch": "No matching history assets",
  "canvas.history.noMatchOtherTabs": "No matches in this tab — try {{tabs}}",
};

const i18nState = vi.hoisted(() => ({ language: "zh" }));
const canvasState = vi.hoisted(() => ({ nodes: [] as unknown[] }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const table = i18nState.language.startsWith("zh") ? translations : enTranslations;
      const raw = table[key] ?? key;
      return options
        ? raw.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ""))
        : raw;
    },
    i18n: { language: i18nState.language, resolvedLanguage: i18nState.language },
  }),
}));

vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: (selector: (state: { nodes: unknown[] }) => unknown) => selector(canvasState),
}));

// 只测搜索框键盘行为与空态文案,把生成历史/查看器/导演台整条依赖图挡在门外
// (viewer-kit 那条会把 three.js 拖进 jsdom)。
vi.mock("@/features/canvas/hooks/useCanvasGenerationHistory", () => ({
  useCanvasGenerationHistory: () => ({ records: [], isLoading: false }),
}));
vi.mock("@/features/canvas/ui/ImageViewerModal", () => ({ ImageViewerModal: () => null }));
vi.mock("@/features/canvas/ui/VideoViewerModal", () => ({ VideoViewerModal: () => null }));
vi.mock("@/features/viewer-kit/three-d/ThreeDDirectorDialog", () => ({
  ThreeDDirectorDialog: () => null,
}));
vi.mock("@/features/viewer-kit/three-d/directorManifest", () => ({
  buildStandaloneWorldManifest: () => null,
}));

import { CanvasHistoryAssetsModal } from "@/features/canvas/ui/CanvasHistoryAssetsModal";

function node(type: string, id: string, data: Record<string, unknown>) {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

function renderModal(onClose = vi.fn()) {
  render(
    <CanvasHistoryAssetsModal
      onClose={onClose}
      onUseAsset={vi.fn()}
      onDeleteNode={vi.fn()}
      assetSource="live-canvas"
    />,
  );
  return { onClose, input: screen.getByRole("searchbox") as HTMLInputElement };
}

afterEach(() => {
  i18nState.language = "zh";
  canvasState.nodes = [];
});

describe("CanvasHistoryAssetsModal 搜索框 Escape", () => {
  it("组字中按 Escape 只取消候选词,不关弹窗、不清空已输入的查询", async () => {
    const { onClose, input } = renderModal();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "xiaomao" } });
    // 浏览器在 IME 组字期间照样把 Escape 的 keydown 冒泡到 document —— 这正是回归点:
    // 搜索框守卫会跳过(不 stopPropagation),全局监听必须自己认出 isComposing。
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
    expect(input.value).toBe("xiaomao");
  });

  it("非组字状态下,框里有内容时 Escape 先清空搜索、不关弹窗", async () => {
    const user = userEvent.setup();
    const { onClose, input } = renderModal();

    await user.type(input, "cat");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("搜索框为空时 Escape 关闭弹窗", () => {
    const { onClose, input } = renderModal();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("CanvasHistoryAssetsModal 跨分类空态", () => {
  // resolveMediaUrl 只放行同源 /static 路径,跨域绝对 url 会被判 null(资产就进不了桶)。
  const nodes = [
    node(CANVAS_NODE_TYPES.upload, "n-img", {
      imageUrl: "/static/demo/dog.png",
      displayName: "dog",
    }),
    node(CANVAS_NODE_TYPES.video, "n-vid", {
      videoUrl: "/static/demo/cat.mp4",
      displayName: "cat clip",
    }),
    node(CANVAS_NODE_TYPES.audio, "n-aud", {
      audioUrl: "/static/demo/cat.mp3",
      displayName: "cat theme",
    }),
  ];

  it("中文界面用顿号 + 或连接其他命中分类", async () => {
    const user = userEvent.setup();
    canvasState.nodes = nodes;
    const { input } = renderModal();

    await user.type(input, "cat");

    expect(screen.getByText("当前分类没有匹配项，试试视频历史或音频历史")).toBeInTheDocument();
  });

  it("英文界面用英文连接词,不出现中文顿号", async () => {
    const user = userEvent.setup();
    i18nState.language = "en";
    canvasState.nodes = nodes;
    const { input } = renderModal();

    await user.type(input, "cat");

    const empty = screen.getByText(/No matches in this tab/);
    expect(empty).toHaveTextContent("try Videos or Audio");
    expect(empty.textContent).not.toContain("、");
  });
});
