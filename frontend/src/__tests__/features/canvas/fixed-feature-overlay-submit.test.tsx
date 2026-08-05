// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 360 全景 / 宫格动作两个面板：提交必须带上报价时用的那个模型与档位。
//
// 单测 `resolveFixedFeatureModelRequest` 只能证明解析结果自洽；这两个面板真正
// 出过的问题是解析完了根本没往 payload 里放 —— 所以断言必须落在 ops helper 收到
// 的 payload 上。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Scene360Overlay } from "@/features/canvas/ui/Scene360Overlay";
import { GridActionConfirmOverlay } from "@/features/canvas/ui/GridActionConfirmOverlay";
import type { GridActionRequest } from "@/features/canvas/ui/GridActionConfirmOverlay";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

vi.mock("@xyflow/react", () => ({
  NodeToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Top: "top", Bottom: "bottom" },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 目录首模型：既不是后端默认模型，也不支持面板默认的 2K / medium。
const CATALOG_MODEL = {
  catalogId: "cat-77",
  id: "studio-image-v1",
  providerId: "openrouter" as const,
  apiModel: "google/gemini-2.5-flash-image-preview",
  label: "Studio Image",
  resolutionOptions: ["1K", "4K"],
  qualityOptions: ["low", "high"],
};

vi.mock("@/features/canvas/hooks/useFreezoneImageModels", () => ({
  useFreezoneImageModels: () => ({
    models: [CATALOG_MODEL],
    isLoading: false,
    isFallback: false,
    error: null,
  }),
  prefetchFreezoneImageModels: () => {},
}));

const submitFreezoneScene360 = vi.fn();
const submitFreezoneTemplateEdit = vi.fn();
const fetchFreezoneJobResult = vi.fn();
const awaitTaskCompletion = vi.fn();
const useGenerationCreditCost = vi.fn();

vi.mock("@/api/ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops")>();
  return {
    ...actual,
    submitFreezoneScene360: (...args: unknown[]) => submitFreezoneScene360(...args),
    submitFreezoneTemplateEdit: (...args: unknown[]) => submitFreezoneTemplateEdit(...args),
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
  data: { imageUrl: "https://x/src.png", aspectRatio: "1:1" },
} as unknown as CanvasNode;

const JOB_REF = {
  task_type: "freezone_scene_360",
  job_id: "j-1",
  task_key: "freezone_scene_360:j-1",
};

/** 报价 hook 拿到的 params（第三个入参）。 */
function quotedParams(): Record<string, unknown> {
  const options = useGenerationCreditCost.mock.calls[0][2] as {
    params: Record<string, unknown>;
  };
  return options.params;
}

beforeEach(() => {
  vi.clearAllMocks();
  submitFreezoneScene360.mockResolvedValue(JOB_REF);
  submitFreezoneTemplateEdit.mockResolvedValue({ ...JOB_REF, task_type: "freezone_edit" });
  awaitTaskCompletion.mockResolvedValue({ result: { output_url: "https://x/out.png" } });
  useGenerationCreditCost.mockReturnValue({ data: undefined, error: null });
});

describe("360 全景面板", () => {
  it("提交带上报价用的模型、目录身份、尺寸与画质", async () => {
    render(
      <Scene360Overlay node={NODE} imageSource="https://x/src.png?t=1" onClose={() => {}} />,
    );
    const quoted = quotedParams();
    fireEvent.click(screen.getByTitle("scene360.submit"));

    await waitFor(() => expect(submitFreezoneScene360).toHaveBeenCalled());
    const payload = submitFreezoneScene360.mock.calls[0][1] as Record<string, unknown>;
    // 之前这里只有 referenceUrl + aspectRatio，模型与档位全交给后端默认值。
    expect(payload.model).toBe(CATALOG_MODEL.apiModel);
    expect(payload.catalogId).toBe(CATALOG_MODEL.catalogId);
    expect(payload.imageSize).toBe("1K");
    expect(payload.quality).toBe("low");
    // 与报价同源。
    expect(payload.imageSize).toBe(quoted.size);
    expect(payload.quality).toBe(quoted.quality);
    expect(payload.model).toBe(quoted.image_selection);
    expect(payload.catalogId).toBe(quoted.catalog_id);
  });
});

describe("宫格动作面板", () => {
  const REQUEST: GridActionRequest = {
    nodeId: NODE.id,
    key: "multiCameraGrid",
    label: "多机位九宫格",
    prompt: "生成九宫格多机位",
    cost: 0,
  };

  it("提交带上报价用的模型、目录身份、尺寸与画质", async () => {
    render(
      <GridActionConfirmOverlay
        node={NODE}
        imageSource="https://x/src.png?t=1"
        request={REQUEST}
        onClose={() => {}}
      />,
    );
    const quoted = quotedParams();
    fireEvent.click(screen.getByTitle("nodeToolbar.gridMenu.confirmBar.submit"));

    await waitFor(() => expect(submitFreezoneTemplateEdit).toHaveBeenCalled());
    const payload = submitFreezoneTemplateEdit.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.model).toBe(CATALOG_MODEL.apiModel);
    expect(payload.catalogId).toBe(CATALOG_MODEL.catalogId);
    expect(payload.imageSize).toBe("1K");
    expect(payload.quality).toBe("low");
    expect(payload.imageSize).toBe(quoted.size);
    expect(payload.quality).toBe(quoted.quality);
    expect(payload.model).toBe(quoted.image_selection);
    expect(payload.catalogId).toBe(quoted.catalog_id);
    // mode 只属于报价维度，不能混进模型字段。
    expect(payload.mode).toBe("multi_camera_nine_grid");
    expect(quoted.mode).toBe("multi_camera_nine_grid");
  });
});
