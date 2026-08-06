// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 超分 / 重绘两个面板：后台一个图片模型都没配时必须禁用提交。
//
// 这两个面板原来都在选模型的尾巴上挂了 `?? SHARED_MODELS.find(...)`：目录明明
// 是空的（接口成功返回空列表 = 后台的权威答案），面板却拿前端硬编码的模型顶上
// 去，界面显示一切正常，用户点下去才被后端 `_resolve_catalog_request` 用 409 顶
// 回来。拉取失败时的兜底是对的（不然接口一抖用户就干不了活），把「没配」伪装成
// 「有」是错的。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpscaleEditorOverlay } from "@/features/canvas/ui/UpscaleEditorOverlay";
import { RedrawOverlay } from "@/features/canvas/ui/RedrawOverlay";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

// NodeToolbar 要挂在真的 ReactFlow store 上才渲染内容，这里只关心工具条里的按钮。
vi.mock("@xyflow/react", () => ({
  NodeToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Top: "top", Bottom: "bottom" },
  useStore: (selector: (state: { transform: number[] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const CATALOG_MODEL = {
  id: "studio-image-v1",
  providerId: "openrouter" as const,
  apiModel: "google/gemini-2.5-flash-image-preview",
  label: "Studio Image",
  resolutionOptions: ["1K", "4K"],
};

type ImageCatalogState = {
  models: (typeof CATALOG_MODEL)[];
  isLoading: boolean;
  isFallback: boolean;
  error: Error | null;
};

const LOADED_CATALOG: ImageCatalogState = {
  models: [CATALOG_MODEL],
  isLoading: false,
  isFallback: false,
  error: null,
};

const EMPTY_CATALOG: ImageCatalogState = {
  models: [],
  isLoading: false,
  isFallback: false,
  error: null,
};

let imageCatalogState: ImageCatalogState = LOADED_CATALOG;

// 只替换取数的 hook；`isAuthoritativeEmptyCatalog` 是纯函数判据，面板正是
// 靠它决定禁不禁用提交，必须留真实实现。
vi.mock("@/features/canvas/hooks/useFreezoneImageModels", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/canvas/hooks/useFreezoneImageModels")
  >()),
  useFreezoneImageModels: () => imageCatalogState,
  prefetchFreezoneImageModels: () => {},
}));

const submitFreezoneUpscale = vi.fn();
const fetchFreezoneJobResult = vi.fn();
const awaitTaskCompletion = vi.fn();
const useGenerationCreditCost = vi.fn();

vi.mock("@/api/ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops")>();
  return {
    ...actual,
    submitFreezoneUpscale: (...args: unknown[]) => submitFreezoneUpscale(...args),
    fetchFreezoneJobResult: (...args: unknown[]) => fetchFreezoneJobResult(...args),
  };
});

vi.mock("@/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tasks")>();
  return {
    ...actual,
    awaitTaskCompletion: (...args: unknown[]) => awaitTaskCompletion(...args),
  };
});

vi.mock("@/lib/url-params", () => ({
  readUrl: () => ({ project: "demo", canvas: "default" }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: (...args: unknown[]) => useGenerationCreditCost(...args),
}));

const UPSCALE_NODE: CanvasNode = {
  id: "upscale-node",
  type: "exportImage",
  position: { x: 0, y: 0 },
  data: {
    imageUrl: "https://x/src.png",
    aspectRatio: "1:1",
    upscaleSourceUrl: "https://x/src.png",
  },
} as unknown as CanvasNode;

const REDRAW_NODE: CanvasNode = {
  id: "redraw-node",
  type: "exportImage",
  position: { x: 0, y: 0 },
  data: { imageUrl: "https://x/src.png", aspectRatio: "1:1" },
} as unknown as CanvasNode;

beforeEach(() => {
  vi.clearAllMocks();
  imageCatalogState = LOADED_CATALOG;
  submitFreezoneUpscale.mockResolvedValue({
    task_type: "freezone_image",
    job_id: "up-1",
    task_key: "freezone_image:up-1",
  });
  awaitTaskCompletion.mockResolvedValue({ result: { output_url: "https://x/out.png" } });
  useGenerationCreditCost.mockReturnValue({ data: undefined, error: null });
});

describe("超分面板", () => {
  it("后台一个图片模型都没配时禁用提交，点了也不发请求", () => {
    imageCatalogState = EMPTY_CATALOG;
    render(<UpscaleEditorOverlay node={UPSCALE_NODE} />);

    const button = screen.getByTitle("modelParams.noModelsAvailable");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(submitFreezoneUpscale).not.toHaveBeenCalled();
  });

  it("拉取失败回落到兜底列表时照常可提交", async () => {
    imageCatalogState = {
      models: [CATALOG_MODEL],
      isLoading: false,
      isFallback: true,
      error: new Error("boom"),
    };
    render(<UpscaleEditorOverlay node={UPSCALE_NODE} />);

    fireEvent.click(screen.getByTitle("upscaleEditor.submit"));
    await waitFor(() => expect(submitFreezoneUpscale).toHaveBeenCalled());
  });
});

describe("重绘面板", () => {
  it("后台一个图片模型都没配时禁用提交", () => {
    imageCatalogState = EMPTY_CATALOG;
    render(
      <RedrawOverlay
        node={REDRAW_NODE}
        imageSource="https://x/src.png?token=1"
        onClose={() => {}}
      />,
    );

    const button = screen.getByTitle("modelParams.noModelsAvailable");
    expect(button).toBeDisabled();
  });
});
