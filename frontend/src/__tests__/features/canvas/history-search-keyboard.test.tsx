// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

const translations: Record<string, string> = {
  "canvas.history.title": "历史资产",
  "canvas.history.tabs.image": "图片历史",
  "canvas.history.tabs.video": "视频历史",
  "canvas.history.tabs.audio": "音频历史",
  "canvas.history.tabs.world": "世界历史",
  "canvas.history.noMatch": "没有匹配的历史资产",
  "canvas.history.noMatchOtherTabs": "当前分类没有匹配项，试试{{tabs}}",
  "canvas.history.delete": "删除",
  "canvas.history.deleteConfirmTitle": "删除这条历史资产？",
  "canvas.history.deleteConfirmDescription": "删除后将不再出现在历史资产中，且无法恢复。画布中已使用的内容不会受影响。",
  "canvas.history.deleteConfirmAction": "删除",
  "canvas.history.promptTitle": "提示词",
  "canvas.history.viewFullPrompt": "查看完整提示词",
  "common.cancel": "取消",
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
const historyState = vi.hoisted(() => ({
  records: [] as Record<string, unknown>[],
  removeRecord: vi.fn(),
}));

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
  useCanvasGenerationHistory: () => ({
    records: historyState.records,
    isLoading: false,
    removeRecord: historyState.removeRecord,
  }),
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
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";

function node(type: string, id: string, data: Record<string, unknown>) {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

function renderModal(
  onClose = vi.fn(),
  assetSource: "generation-history" | "live-canvas" = "live-canvas",
) {
  render(
    <>
      <CanvasHistoryAssetsModal
        onClose={onClose}
        onUseAsset={vi.fn()}
        onDeleteNode={vi.fn()}
        assetSource={assetSource}
      />
      <ConfirmDialogHost />
    </>,
  );
  return { onClose, input: screen.getByRole("searchbox") as HTMLInputElement };
}

afterEach(() => {
  i18nState.language = "zh";
  canvasState.nodes = [];
  historyState.records = [];
  historyState.removeRecord.mockReset();
});

describe("CanvasHistoryAssetsModal 删除确认", () => {
  it("取消时不删除，确认后删除对应历史记录", async () => {
    const user = userEvent.setup();
    historyState.records = [
      {
        schema_version: 1,
        canvas_id: "default",
        node_id: "n1",
        recorded_at: "2026-07-17T00:00:00Z",
        id: "image:r1",
        task_type: "image",
        task_key: "image",
        job_id: "r1",
        status: "completed",
        media_type: "image",
        result: { output_url: "/static/demo/history.png" },
      },
    ];
    historyState.removeRecord.mockResolvedValue(true);
    renderModal(vi.fn(), "generation-history");

    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("删除这条历史资产？");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(historyState.removeRecord).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }),
    );
    expect(historyState.removeRecord).toHaveBeenCalledWith("n1", "image:r1");
  });
});

describe("CanvasHistoryAssetsModal 提示词渐进展示", () => {
  it("卡片只显示两行摘要，单击后打开完整提示词", async () => {
    const user = userEvent.setup();
    const prompt = "为小游戏设计一张横版海报，主角正在不同高度的平台之间跳跃。";
    historyState.records = [
      {
        schema_version: 1,
        canvas_id: "default",
        node_id: "n1",
        recorded_at: "2026-08-27T00:00:00Z",
        id: "image:prompt",
        task_type: "image",
        task_key: "image",
        job_id: "prompt",
        status: "completed",
        media_type: "image",
        prompt,
        result: { output_url: "/static/demo/history-prompt.png" },
      },
    ];
    renderModal(vi.fn(), "generation-history");

    const caption = screen.getByRole("button", { name: "查看完整提示词" });
    expect(caption).toHaveClass("h-12");
    expect(caption.querySelector("span")).toHaveClass("line-clamp-2");
    expect(caption).toHaveAttribute("title", "查看完整提示词");
    expect(caption.querySelector("svg")).toHaveClass("lucide-maximize-2");
    const hoverLayer = caption.closest(".group")?.querySelector('[class*="backdrop-blur"]');
    expect(hoverLayer).toHaveClass("bg-black/50", "backdrop-blur-[10px]");
    expect(hoverLayer?.parentElement).toHaveClass("isolate", "rounded-t-md");
    expect(hoverLayer?.parentElement).toHaveStyle({
      clipPath: "inset(0 round var(--radius-md) var(--radius-md) 0 0)",
    });

    await user.click(caption);
    expect(screen.getByRole("heading", { name: "提示词" })).toBeInTheDocument();
    expect(screen.getAllByText(prompt)).toHaveLength(2);
  });
});

describe("CanvasHistoryAssetsModal 固定五列布局", () => {
  it("移除比例调节并让每个日期分组固定为五列网格", () => {
    historyState.records = Array.from({ length: 7 }, (_, index) => ({
      schema_version: 1,
      canvas_id: "default",
      node_id: `n${index}`,
      recorded_at: "2026-08-27T00:00:00Z",
      id: `image:${index}`,
      task_type: "image",
      task_key: "image",
      job_id: `job-${index}`,
      status: "completed",
      media_type: "image",
      result: { output_url: `/static/demo/history-${index}.png` },
    }));
    renderModal(vi.fn(), "generation-history");

    const dialog = screen.getByRole("dialog", { name: "历史资产" });
    const assetGrid = dialog.querySelector(".grid-cols-5");

    expect(dialog).toHaveClass("w-[min(1200px,94vw)]");
    expect(assetGrid).toHaveClass("grid", "grid-cols-5", "gap-3");
    expect(assetGrid?.children).toHaveLength(7);
    expect(screen.queryByLabelText("canvas.toolbar.zoomOut")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("canvas.toolbar.zoomIn")).not.toBeInTheDocument();
  });
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
