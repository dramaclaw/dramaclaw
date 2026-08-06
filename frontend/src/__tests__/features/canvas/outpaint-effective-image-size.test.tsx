// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 扩图面板：报价、UI 显示、提交必须用同一个分辨率档位。
//
// 面板上的 `imageSize` 是用户上一次挑的原始值，默认 '2K'。后台给某个模型只配了
// 别的档位时，`pickAllowedOption` 会把它收敛成 effectiveImageSize —— 下拉框显示的
// 是收敛值、报价算的也是收敛值，唯独提交带的是那个越界的原始值：用户看到 A、
// 按 A 计费、后端收到 B（还可能因为不在目录档位里直接被判非法）。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OutpaintEditorOverlay } from "@/features/canvas/ui/OutpaintEditorOverlay";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

// NodeToolbar 要挂在真的 ReactFlow store 上才渲染内容，这里只关心工具条里的按钮，
// 用透传壳替掉即可。
vi.mock("@xyflow/react", () => ({
  NodeToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Top: "top", Bottom: "bottom" },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 后台只给这个模型配了 1K / 4K —— 面板默认的 '2K' 不在档位里。
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

/** 默认给一条正常目录；单个用例可以改成加载中 / 拉取失败 / 权威空目录。 */
const LOADED_CATALOG: ImageCatalogState = {
  models: [CATALOG_MODEL],
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

const submitFreezoneOutpaint = vi.fn();
const fetchFreezoneJobResult = vi.fn();
const awaitTaskCompletion = vi.fn();
const useGenerationCreditCost = vi.fn();

vi.mock("@/api/ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops")>();
  return {
    ...actual,
    submitFreezoneOutpaint: (...args: unknown[]) => submitFreezoneOutpaint(...args),
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

const NODE: CanvasNode = {
  id: "src-node",
  type: "exportImage",
  position: { x: 0, y: 0 },
  data: {
    imageUrl: "https://x/src.png",
    aspectRatio: "1:1",
  },
} as unknown as CanvasNode;

function renderOverlay() {
  return render(
    <OutpaintEditorOverlay
      node={NODE}
      imageSource="https://x/src.png?token=1"
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  imageCatalogState = LOADED_CATALOG;
  submitFreezoneOutpaint.mockResolvedValue({
    task_type: "freezone_image",
    job_id: "out-1",
    task_key: "freezone_image:out-1",
  });
  awaitTaskCompletion.mockResolvedValue({ result: { output_url: "https://x/out.png" } });
  useGenerationCreditCost.mockReturnValue({ data: undefined, error: null });
});

describe("扩图面板的分辨率档位", () => {
  it("提交的是收敛后的档位，不是越界的原始选择", async () => {
    renderOverlay();
    fireEvent.click(screen.getByTitle("outpaintEditor.submit"));

    await waitFor(() => expect(submitFreezoneOutpaint).toHaveBeenCalled());
    const body = submitFreezoneOutpaint.mock.calls[0][1] as Record<string, unknown>;
    // 默认状态是 '2K'，但该模型只配了 1K / 4K → 必须落到首个可用档位 '1K'。
    expect(body.imageSize).toBe("1K");
    expect(body.imageSize).not.toBe("2K");
  });

  it("报价与提交用同一个档位", async () => {
    renderOverlay();
    const quoteOptions = useGenerationCreditCost.mock.calls[0][2] as {
      params: Record<string, unknown>;
    };
    fireEvent.click(screen.getByTitle("outpaintEditor.submit"));

    await waitFor(() => expect(submitFreezoneOutpaint).toHaveBeenCalled());
    const body = submitFreezoneOutpaint.mock.calls[0][1] as Record<string, unknown>;
    // 报价接口收到什么档位，后端就按什么档位扣费；提交必须一模一样。
    expect(body.imageSize).toBe(quoteOptions.params.size);
  });

  it("用户显式选中的档位在允许范围内时原样提交", async () => {
    renderOverlay();
    // 打开分辨率下拉（触发器上显示的就是当前收敛值 1K），挑一个模型确实支持的档位。
    fireEvent.click(screen.getByText("1K"));
    fireEvent.click(screen.getByText("4K"));
    fireEvent.click(screen.getByTitle("outpaintEditor.submit"));

    await waitFor(() => expect(submitFreezoneOutpaint).toHaveBeenCalled());
    const body = submitFreezoneOutpaint.mock.calls[0][1] as Record<string, unknown>;
    expect(body.imageSize).toBe("4K");
  });
});

describe("扩图面板的权威空目录", () => {
  it("后台一个图片模型都没配时禁用提交，点了也不发请求", () => {
    imageCatalogState = { models: [], isLoading: false, isFallback: false, error: null };
    renderOverlay();
    // 原来这里还挂着 `?? SHARED_MODELS.find(...)`：目录明明是空的，面板却拿前端
    // 硬编码的模型顶上去，用户点下去只会收到后端 409。
    const button = screen.getByTitle("modelParams.noModelsAvailable");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(submitFreezoneOutpaint).not.toHaveBeenCalled();
  });

  it("拉取失败回落到兜底列表时照常可提交", async () => {
    imageCatalogState = {
      models: [CATALOG_MODEL],
      isLoading: false,
      isFallback: true,
      error: new Error("boom"),
    };
    renderOverlay();
    fireEvent.click(screen.getByTitle("outpaintEditor.submit"));
    await waitFor(() => expect(submitFreezoneOutpaint).toHaveBeenCalled());
  });
});
