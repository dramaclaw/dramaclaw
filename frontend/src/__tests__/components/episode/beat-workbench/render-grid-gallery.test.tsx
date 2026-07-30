// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { RenderGridGallery } from "@/components/episode/beat-workbench/render-grid-gallery";
import type { Beat } from "@/types/episode";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    resources: {
      zh: {
        translation: {
          common: {
            regenerate: "重新生成",
            download: "下载",
            stop: "停止",
            upload: "上传",
            copy: "复制",
            billingRuleNotConfiguredShort: "需配置",
          },
          episode: {
            workbench: {
              renderGrid: {
                title: "Render Grid",
                titleWithCount: "Render Grid ({{count}} grids)",
                gridCount: "{{count}} 个 grid",
                gridLabel: "Grid #{{n}}",
                cellCount: "{{count}} 格",
                cut: "切割入池",
                regenStarted: "Grid #{{n}} 已启动",
                regenFailed: "Grid 重生失败",
                cutSuccess: "Grid #{{n}} 已切割",
                cutFailed: "Grid 切割失败",
                uploadGrid: "上传 grid",
                rebuildIndex: "重建索引",
                rebuildSuccess: "索引重建完成：{{count}} 张图片",
                rebuildFailed: "索引重建失败",
                uploadSuccess: "Grid #{{n}} 已上传",
                uploadFailed: "Grid 上传失败",
                exportPrompt: "导出 prompt",
                promptTitle: "Grid #{{n}} prompt",
                promptContent: "Prompt 内容",
                promptFailed: "Prompt 导出失败",
                copySuccess: "Prompt 已复制",
              },
            },
          },
        },
      },
    },
  });
});

const regenerateGridMock: Mock = vi.fn();
const cutGridMock: Mock = vi.fn();
const uploadGridMock: Mock = vi.fn();
const exportGridPromptMock: Mock = vi.fn();
const rebuildPoolIndexMock: Mock = vi.fn();
const taskStartMock: Mock = vi.fn();
const taskStopMock: Mock = vi.fn();
let gridImages: unknown[] = [];

function beatWithScene(beatNumber: number, sceneId: string): Beat {
  return {
    beat_number: beatNumber,
    narration_segment: `Beat ${beatNumber}`,
    visual_description: "",
    video_prompt: "",
    location: sceneId,
    location_description: sceneId,
    scene_ref: { scene_id: sceneId },
  };
}

vi.mock("@/lib/queries/sketches", () => ({
  useGrids: () => ({
    data: {
      ok: true,
      data: {
        episode: 1,
        modes: {},
        beat_assignments: {},
        images: gridImages,
      },
    },
  }),
  useRegenerateGrid: () => ({
    mutateAsync: regenerateGridMock,
    isPending: false,
  }),
  useCutGrid: () => ({
    mutateAsync: cutGridMock,
    isPending: false,
  }),
  useUploadGrid: () => ({
    mutateAsync: uploadGridMock,
    isPending: false,
  }),
  useRebuildPoolIndex: () => ({
    mutateAsync: rebuildPoolIndexMock,
    isPending: false,
  }),
  useExportGridPrompt: () => ({
    mutateAsync: exportGridPromptMock,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    start: taskStartMock,
    stop: taskStopMock,
    started: false,
    stopping: false,
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({
    data: { data: { display: "8" } },
    error: null,
  }),
}));

vi.mock("@/lib/queries/render-settings", () => ({
  useRenderSettings: () => ({
    data: { data: { render_image_selection: "newapi_gpt_image_2" } },
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  gridImages = [
    {
      id: "render-1",
      type: "render",
      mode: "2x2",
      grid_index: 2,
      cell_index: 0,
      row: 0,
      col: 0,
      original_beat: 5,
      cell_url: "/static/cell-5.png",
      grid_url: "/static/grid-2.png",
      grid_path: "render/grid_02.png",
      generated_at: "2026-05-16T09:00:00Z",
      stale: false,
    },
    {
      id: "render-2",
      type: "render",
      mode: "2x2",
      grid_index: 2,
      cell_index: 1,
      row: 0,
      col: 1,
      original_beat: 6,
      cell_url: "/static/cell-6.png",
      grid_url: "/static/grid-2.png",
      grid_path: "render/grid_02.png",
      generated_at: "2026-05-16T09:00:00Z",
      stale: false,
    },
    {
      id: "sketch-1",
      type: "sketch",
      mode: "2x2",
      grid_index: 2,
      cell_index: 0,
      row: 0,
      col: 0,
      original_beat: 5,
      cell_url: "/static/sketch-5.png",
      grid_url: "/static/sketch-grid-2.png",
      grid_path: "sketch/grid_02.png",
      generated_at: "2026-05-16T08:00:00Z",
      stale: false,
    },
  ];
  regenerateGridMock.mockReset();
  regenerateGridMock.mockResolvedValue({
    ok: true,
    task_type: "grid_regenerate",
    message: "started",
  });
  cutGridMock.mockReset();
  cutGridMock.mockResolvedValue({ ok: true, data: { added: 2, skipped: 0 } });
  uploadGridMock.mockReset();
  uploadGridMock.mockResolvedValue({
    ok: true,
    data: { grid_index: 2, grid_url: "/static/grid-new.png" },
  });
  rebuildPoolIndexMock.mockReset();
  rebuildPoolIndexMock.mockResolvedValue({
    ok: true,
    data: { episode: 1, image_count: 8 },
  });
  exportGridPromptMock.mockReset();
  exportGridPromptMock.mockResolvedValue({
    ok: true,
    data: { prompt: "render prompt text", prompt_path: "custom/prompt.txt" },
  });
  taskStartMock.mockReset();
  taskStopMock.mockReset();
});

describe("RenderGridGallery", () => {
  it("shows a pool rebuild action when no render grids are indexed", async () => {
    const user = userEvent.setup();
    gridImages = [];

    render(
      <I18nextProvider i18n={i18n}>
        <RenderGridGallery project="demo" episode={1} />
      </I18nextProvider>,
    );

    expect(screen.getByText(/Render Grid/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重建索引" }));

    expect(rebuildPoolIndexMock).toHaveBeenCalledTimes(1);
  });

  it("renders render grid cards without mixing sketch cells", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <RenderGridGallery project="demo" episode={1} />
      </I18nextProvider>,
    );

    expect(screen.getByText(/Render Grid/)).toBeInTheDocument();
    expect(screen.getByText("Grid #2")).toBeInTheDocument();
    expect(screen.getByText(/2 格/)).toBeInTheDocument();
  });

  it("keeps custom render grids separate when backend pool grid_index is reused", () => {
    gridImages = [
      {
        id: "basement-1",
        type: "render",
        mode: "3x3",
        grid_index: 0,
        cell_index: 0,
        row: 0,
        col: 0,
        original_beat: 1,
        cell_url: "/static/basement-1.png",
        grid_url: "/static/basement-grid.png",
        grid_path: "custom/render_3x3_1-2-3-4-5-6_grid.png",
        generated_at: "2026-05-18T09:00:00Z",
        stale: false,
      },
      {
        id: "basement-2",
        type: "render",
        mode: "3x3",
        grid_index: 0,
        cell_index: 1,
        row: 0,
        col: 1,
        original_beat: 2,
        cell_url: "/static/basement-2.png",
        grid_url: "/static/basement-grid.png",
        grid_path: "custom/render_3x3_1-2-3-4-5-6_grid.png",
        generated_at: "2026-05-18T09:00:00Z",
        stale: false,
      },
      {
        id: "basement-3",
        type: "render",
        mode: "3x3",
        grid_index: 0,
        cell_index: 2,
        row: 0,
        col: 2,
        original_beat: 3,
        cell_url: "/static/basement-3.png",
        grid_url: "/static/basement-grid.png",
        grid_path: "custom/render_3x3_1-2-3-4-5-6_grid.png",
        generated_at: "2026-05-18T09:00:00Z",
        stale: false,
      },
      {
        id: "basement-4",
        type: "render",
        mode: "3x3",
        grid_index: 0,
        cell_index: 3,
        row: 1,
        col: 0,
        original_beat: 4,
        cell_url: "/static/basement-4.png",
        grid_url: "/static/basement-grid.png",
        grid_path: "custom/render_3x3_1-2-3-4-5-6_grid.png",
        generated_at: "2026-05-18T09:00:00Z",
        stale: false,
      },
      {
        id: "basement-5",
        type: "render",
        mode: "3x3",
        grid_index: 0,
        cell_index: 4,
        row: 1,
        col: 1,
        original_beat: 5,
        cell_url: "/static/basement-5.png",
        grid_url: "/static/basement-grid.png",
        grid_path: "custom/render_3x3_1-2-3-4-5-6_grid.png",
        generated_at: "2026-05-18T09:00:00Z",
        stale: false,
      },
      {
        id: "basement-6",
        type: "render",
        mode: "3x3",
        grid_index: 0,
        cell_index: 5,
        row: 1,
        col: 2,
        original_beat: 6,
        cell_url: "/static/basement-6.png",
        grid_url: "/static/basement-grid.png",
        grid_path: "custom/render_3x3_1-2-3-4-5-6_grid.png",
        generated_at: "2026-05-18T09:00:00Z",
        stale: false,
      },
      {
        id: "store-7",
        type: "render",
        mode: "5x5",
        grid_index: 0,
        cell_index: 0,
        row: 0,
        col: 0,
        original_beat: 7,
        cell_url: "/static/store-7.png",
        grid_url: "/static/store-grid.png",
        grid_path: "custom/render_5x5_7-8-18-19_grid.png",
        generated_at: "2026-05-18T09:05:00Z",
        stale: false,
      },
      {
        id: "store-8",
        type: "render",
        mode: "5x5",
        grid_index: 0,
        cell_index: 1,
        row: 0,
        col: 1,
        original_beat: 8,
        cell_url: "/static/store-8.png",
        grid_url: "/static/store-grid.png",
        grid_path: "custom/render_5x5_7-8-18-19_grid.png",
        generated_at: "2026-05-18T09:05:00Z",
        stale: false,
      },
      {
        id: "store-18",
        type: "render",
        mode: "5x5",
        grid_index: 0,
        cell_index: 2,
        row: 0,
        col: 2,
        original_beat: 18,
        cell_url: "/static/store-18.png",
        grid_url: "/static/store-grid.png",
        grid_path: "custom/render_5x5_7-8-18-19_grid.png",
        generated_at: "2026-05-18T09:05:00Z",
        stale: false,
      },
      {
        id: "store-19",
        type: "render",
        mode: "5x5",
        grid_index: 0,
        cell_index: 3,
        row: 0,
        col: 3,
        original_beat: 19,
        cell_url: "/static/store-19.png",
        grid_url: "/static/store-grid.png",
        grid_path: "custom/render_5x5_7-8-18-19_grid.png",
        generated_at: "2026-05-18T09:05:00Z",
        stale: false,
      },
    ];

    render(
      <I18nextProvider i18n={i18n}>
        <RenderGridGallery
          project="demo"
          episode={1}
          beats={[
            ...[1, 2, 3, 4, 5, 6].map((beat) => beatWithScene(beat, "地下室")),
            ...[7, 8, 18, 19].map((beat) => beatWithScene(beat, "旧书店一楼")),
          ]}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText("Grid #0")).toBeInTheDocument();
    expect(screen.getByText("Grid #1")).toBeInTheDocument();
    expect(screen.getByText(/B1-6/)).toBeInTheDocument();
    expect(screen.getByText(/B7-8,18-19/)).toBeInTheDocument();
    expect(screen.getByAltText("Grid #1")).toHaveAttribute("src", "/static/store-grid.png");
  });

  it("can regenerate and cut a render grid", async () => {
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={i18n}>
        <RenderGridGallery project="demo" episode={1} />
      </I18nextProvider>,
    );

    expect(screen.getByText("8")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新生成" }));
    expect(regenerateGridMock).toHaveBeenCalledWith({
      gridIndex: 2,
      sceneGrouping: true,
    });
    expect(taskStartMock).toHaveBeenCalledWith({ scope: "grid_2" });

    await user.click(screen.getByRole("button", { name: "切割入池" }));
    expect(cutGridMock).toHaveBeenCalledWith({
      gridIndex: 2,
      rows: 1,
      cols: 2,
      modeKey: "2x2",
      beatNumbers: [5, 6],
      gridType: "render",
    });
  });

  it("can upload a render grid replacement and export its prompt", async () => {
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={i18n}>
        <RenderGridGallery project="demo" episode={1} />
      </I18nextProvider>,
    );
    const file = new File(["grid"], "grid.png", { type: "image/png" });

    await user.upload(screen.getByLabelText("上传 grid"), file);
    expect(uploadGridMock).toHaveBeenCalledWith({
      gridIndex: 2,
      file,
      gridType: "render",
      modeKey: "2x2",
      beatNumbers: [5, 6],
    });

    await user.click(screen.getByRole("button", { name: "导出 prompt" }));
    expect(exportGridPromptMock).toHaveBeenCalledWith({
      gridIndex: 2,
      gridType: "render",
      modeKey: "2x2",
      beatNumbers: [5, 6],
    });
    expect(await screen.findByDisplayValue("render prompt text")).toBeInTheDocument();
  });
});
