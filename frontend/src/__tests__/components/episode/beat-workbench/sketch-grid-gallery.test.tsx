// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { SketchGridGallery } from "@/components/episode/beat-workbench/sketch-grid-gallery";
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
            copy: "复制",
            download: "下载",
            regenerate: "重新生成",
            stop: "停止",
            billingRuleNotConfiguredShort: "需配置",
          },
          episode: {
            workbench: {
              sketchGrid: {
                title: "Sketch Grid",
                titleWithCount: "Sketch Grid ({{count}} grids)",
                gridCount: "{{count}} 个 grid",
                gridLabel: "Grid #{{n}}",
                cellCount: "{{count}} 格",
                noPreview: "无预览",
                generateGrid: "生成/重生",
                regenStarted: "Grid #{{n}} 已启动",
                regenFailed: "Grid 生成失败",
                cut: "切割入池",
                cutSuccess: "Grid #{{n}} 已切割",
                cutFailed: "Grid 切割失败",
                uploadGrid: "上传 grid",
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

const generateSketchesMock: Mock = vi.fn();
const cutGridMock: Mock = vi.fn();
const uploadGridMock: Mock = vi.fn();
const exportGridPromptMock: Mock = vi.fn();
const taskStartMock: Mock = vi.fn();
const taskStopMock: Mock = vi.fn();
let gridImages: unknown[] = [];
let sketchPreviewResponses: Record<number, unknown> = {};

vi.mock("@/lib/queries/sketches", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/sketches")>();
  return {
    ...actual,
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
    useGenerateSketches: () => ({
      mutateAsync: generateSketchesMock,
      isPending: false,
    }),
    useSketchGridPreview: (
      _project: string,
      _episode: number,
      params: { gridIndex: number },
    ) => ({
      data: sketchPreviewResponses[params.gridIndex] ?? null,
    }),
    useCutGrid: () => ({
      mutateAsync: cutGridMock,
      isPending: false,
    }),
    useUploadGrid: () => ({
      mutateAsync: uploadGridMock,
      isPending: false,
    }),
    useExportGridPrompt: () => ({
      mutateAsync: exportGridPromptMock,
      isPending: false,
    }),
  };
});

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    started: false,
    stopping: false,
    start: taskStartMock,
    stop: taskStopMock,
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({
    data: { data: { display: "6" } },
    error: null,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  sketchPreviewResponses = {};
  gridImages = [
    {
      id: "sketch-5",
      type: "sketch",
      mode: "2x2_scene",
      grid_index: 4,
      cell_index: 0,
      row: 0,
      col: 0,
      original_beat: 5,
      cell_url: "/static/sketch-5.png",
      grid_url: "/static/sketch-grid-4.png",
      grid_path: "custom/sketch-grid-4.png",
      generated_at: "2026-05-16T08:00:00Z",
      stale: false,
    },
    {
      id: "sketch-6",
      type: "sketch",
      mode: "2x2_scene",
      grid_index: 4,
      cell_index: 1,
      row: 0,
      col: 1,
      original_beat: 6,
      cell_url: "/static/sketch-6.png",
      grid_url: "/static/sketch-grid-4.png",
      grid_path: "custom/sketch-grid-4.png",
      generated_at: "2026-05-16T08:00:00Z",
      stale: false,
    },
  ];
  generateSketchesMock.mockReset();
  generateSketchesMock.mockResolvedValue({
    ok: true,
    task_type: "sketch_grid_generation",
    message: "started",
  });
  cutGridMock.mockReset();
  cutGridMock.mockResolvedValue({ ok: true, data: { added: 2, skipped: 0 } });
  uploadGridMock.mockReset();
  uploadGridMock.mockResolvedValue({ ok: true, data: { grid_index: 4 } });
  exportGridPromptMock.mockReset();
  exportGridPromptMock.mockResolvedValue({
    ok: true,
    data: { prompt: "sketch prompt text" },
  });
  taskStartMock.mockReset();
  taskStopMock.mockReset();
});

describe("SketchGridGallery", () => {
  const plannedBeats: Beat[] = [
    {
      beat_number: 1,
      narration_segment: "one",
      visual_description: "v1",
      scene_ref: { scene_id: "Forest" },
    } as Beat,
    {
      beat_number: 2,
      narration_segment: "two",
      visual_description: "v2",
      scene_ref: { scene_id: "Forest" },
    } as Beat,
  ];

  it("renders planned scene-grouped sketch grids before any grid image exists", async () => {
    gridImages = [];
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery project="demo" episode={1} beats={plannedBeats} />
      </I18nextProvider>,
    );

    expect(screen.getByText(/Sketch Grid/)).toBeInTheDocument();
    expect(screen.getByText("Grid #0")).toBeInTheDocument();
    expect(screen.getByText(/B1-2/)).toBeInTheDocument();
    expect(screen.getByText("无预览")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "生成/重生" }));

    expect(generateSketchesMock).toHaveBeenCalledWith({
      grid_index: 0,
      sketch_scene_grouping: true,
      aspect_ratio: "2:3",
    });
    expect(taskStartMock).toHaveBeenCalledWith({ scope: "grid_0" });
  });

  it("uses beat sketch thumbnails as the NiceGUI-style fallback when a planned grid image is missing", () => {
    gridImages = [];
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery
          project="demo"
          episode={1}
          beats={[
            {
              beat_number: 1,
              narration_segment: "",
              visual_description: "v",
              sketch_url: "/static/beat-1-sketch.png",
              scene_ref: { scene_id: "Forest" },
            } as Beat,
            {
              beat_number: 2,
              narration_segment: "",
              visual_description: "v",
              sketch_url: "/static/beat-2-sketch.png",
              scene_ref: { scene_id: "Forest" },
            } as Beat,
          ]}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByText("无预览")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Grid #0")).toBeInTheDocument();
    expect(container.querySelector('img[src="/static/beat-1-sketch.png"]')).toBeInTheDocument();
    expect(container.querySelector('img[src="/static/beat-2-sketch.png"]')).toBeInTheDocument();
  });

  it("uses pool sketch cells as fallback when beat sketch_url is not populated", () => {
    gridImages = [
      {
        id: "beat-7-sketch",
        type: "sketch",
        mode: "sketch",
        grid_index: 0,
        cell_index: 0,
        row: 0,
        col: 0,
        original_beat: 7,
        cell_url: "/static/pool-beat-7.png",
        grid_url: "",
        grid_path: "",
        generated_at: "2026-05-17T08:00:00Z",
        stale: false,
      },
      {
        id: "beat-8-sketch",
        type: "sketch",
        mode: "sketch",
        grid_index: 0,
        cell_index: 0,
        row: 0,
        col: 0,
        original_beat: 8,
        cell_url: "/static/pool-beat-8.png",
        grid_url: "",
        grid_path: "",
        generated_at: "2026-05-17T08:01:00Z",
        stale: false,
      },
    ];
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery
          project="demo"
          episode={1}
          beats={[
            {
              beat_number: 7,
              narration_segment: "",
              visual_description: "v",
              scene_ref: { scene_id: "Store" },
            } as Beat,
            {
              beat_number: 8,
              narration_segment: "",
              visual_description: "v",
              scene_ref: { scene_id: "Store" },
            } as Beat,
          ]}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByText("无预览")).not.toBeInTheDocument();
    expect(container.querySelector('img[src="/static/pool-beat-7.png"]')).toBeInTheDocument();
    expect(container.querySelector('img[src="/static/pool-beat-8.png"]')).toBeInTheDocument();
  });

  it("uses the NiceGUI-compatible preview API when no local preview source exists", () => {
    gridImages = [];
    sketchPreviewResponses = {
      0: {
        ok: true,
        data: {
          grid_index: 0,
          rows: 2,
          cols: 2,
          beat_numbers: [7, 8],
          preview_path: "sketch_thumb_grid0_7_8_2x2.jpg",
          preview_url: "/static/generated-sketch-preview.jpg",
        },
      },
    };

    render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery
          project="demo"
          episode={1}
          beats={[
            {
              beat_number: 7,
              narration_segment: "",
              visual_description: "v",
              scene_ref: { scene_id: "Store" },
            } as Beat,
            {
              beat_number: 8,
              narration_segment: "",
              visual_description: "v",
              scene_ref: { scene_id: "Store" },
            } as Beat,
          ]}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByText("无预览")).not.toBeInTheDocument();
    expect(screen.getByAltText("Grid #0")).toHaveAttribute(
      "src",
      "/static/generated-sketch-preview.jpg",
    );
  });

  it("matches scoped sketch grid images to planned beat groups instead of trusting grid_index", () => {
    gridImages = [
      {
        id: "store-7",
        type: "sketch",
        mode: "5x5_2-3_sketch",
        grid_index: 0,
        cell_index: 0,
        row: 0,
        col: 0,
        original_beat: 7,
        cell_url: "/static/store-7.png",
        grid_url: "/static/store-grid.png",
        grid_path: "custom/sketch_5x5_2-3_sketch_7-8_grid.png",
        generated_at: "2026-05-18T08:00:00Z",
        stale: false,
      },
      {
        id: "store-8",
        type: "sketch",
        mode: "5x5_2-3_sketch",
        grid_index: 0,
        cell_index: 1,
        row: 0,
        col: 1,
        original_beat: 8,
        cell_url: "/static/store-8.png",
        grid_url: "/static/store-grid.png",
        grid_path: "custom/sketch_5x5_2-3_sketch_7-8_grid.png",
        generated_at: "2026-05-18T08:00:00Z",
        stale: false,
      },
    ];

    render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery
          project="demo"
          episode={1}
          beats={[
            { beat_number: 1, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "Forest" } } as Beat,
            { beat_number: 2, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "Forest" } } as Beat,
            { beat_number: 7, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "Store" } } as Beat,
            { beat_number: 8, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "Store" } } as Beat,
          ]}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText("Grid #1")).toBeInTheDocument();
    expect(screen.getByText(/B7-8/)).toBeInTheDocument();
    expect(screen.getByAltText("Grid #1")).toHaveAttribute("src", "/static/store-grid.png");
  });

  it("wraps grid cards inside a vertical scroller instead of clipping them horizontally", () => {
    gridImages = [];
    render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery
          project="demo"
          episode={1}
          beats={[
            { beat_number: 1, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "A" } } as Beat,
            { beat_number: 2, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "B" } } as Beat,
            { beat_number: 3, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "C" } } as Beat,
          ]}
        />
      </I18nextProvider>,
    );

    const scroller = screen.getByText(/Sketch Grid/).parentElement?.nextElementSibling;
    expect(scroller).toHaveClass("overflow-y-auto");
    expect(scroller?.firstElementChild).toHaveClass("grid");
    expect(scroller?.firstElementChild).not.toHaveClass("flex");
  });

  it("plans and dispatches 16:9 sketch grids when the Sketch aspect toggle is on", async () => {
    gridImages = [];
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery
          project="demo"
          episode={1}
          beats={plannedBeats}
          aspectRatio="16:9"
          imageGenerationSelection="openrouter_nanobanana2"
        />
      </I18nextProvider>,
    );

    await user.click(screen.getByRole("button", { name: "生成/重生" }));

    expect(generateSketchesMock).toHaveBeenCalledWith({
      grid_index: 0,
      sketch_scene_grouping: true,
      aspect_ratio: "16:9",
      image_generation_selection: "openrouter_nanobanana2",
    });
  });

  it("renders sketch grids and dispatches grid-level sketch generation", async () => {
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery project="demo" episode={1} />
      </I18nextProvider>,
    );

    expect(screen.getByText(/Sketch Grid/)).toBeInTheDocument();
    expect(screen.getByText("Grid #4")).toBeInTheDocument();
    expect(screen.getByText(/2 格/)).toBeInTheDocument();
    expect(screen.getByAltText("Grid #4")).toHaveAttribute(
      "src",
      "/static/sketch-grid-4.png",
    );

    await user.click(screen.getByRole("button", { name: "生成/重生" }));

    expect(generateSketchesMock).toHaveBeenCalledWith({
      grid_index: 4,
      sketch_scene_grouping: true,
      aspect_ratio: "2:3",
    });
    expect(taskStartMock).toHaveBeenCalledWith({ scope: "grid_4" });
  });

  it("uses only the latest grid image batch instead of merging historical cells", () => {
    gridImages = [
      {
        id: "old-1",
        type: "sketch",
        mode: "2x2_scene",
        grid_index: 0,
        cell_index: 0,
        row: 0,
        col: 0,
        original_beat: 1,
        cell_url: "/static/old-1.png",
        grid_url: "/static/old-grid.png",
        grid_path: "old-grid.png",
        generated_at: "2026-05-16T08:00:00Z",
        stale: false,
      },
      {
        id: "old-2",
        type: "sketch",
        mode: "2x2_scene",
        grid_index: 0,
        cell_index: 1,
        row: 0,
        col: 1,
        original_beat: 2,
        cell_url: "/static/old-2.png",
        grid_url: "/static/old-grid.png",
        grid_path: "old-grid.png",
        generated_at: "2026-05-16T08:00:00Z",
        stale: false,
      },
      {
        id: "new-1",
        type: "sketch",
        mode: "1x1_2-3_sketch",
        grid_index: 0,
        cell_index: 0,
        row: 0,
        col: 0,
        original_beat: 3,
        cell_url: "/static/new-1.png",
        grid_url: "/static/new-grid.png",
        grid_path: "new-grid.png",
        generated_at: "2026-05-17T08:00:00Z",
        stale: false,
      },
    ];

    render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery project="demo" episode={1} />
      </I18nextProvider>,
    );

    expect(screen.getByText(/1 格/)).toBeInTheDocument();
    expect(screen.queryByText(/3 格/)).not.toBeInTheDocument();
    expect(screen.getByAltText("Grid #0")).toHaveAttribute(
      "src",
      "/static/new-grid.png",
    );
  });

  it("renders non-contiguous scene beat numbers as ranges, not one misleading range", () => {
    gridImages = [];
    render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery
          project="demo"
          episode={1}
          beats={[
            { beat_number: 7, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "Store" } } as Beat,
            { beat_number: 8, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "Store" } } as Beat,
            { beat_number: 18, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "Store" } } as Beat,
            { beat_number: 19, narration_segment: "", visual_description: "v", scene_ref: { scene_id: "Store" } } as Beat,
          ]}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText(/B7-8,18-19/)).toBeInTheDocument();
    expect(screen.queryByText(/B7-19/)).not.toBeInTheDocument();
  });

  it("omits manual sketch grid cutting because generation already splits sketches", async () => {
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={i18n}>
        <SketchGridGallery project="demo" episode={1} />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: "切割入池" })).not.toBeInTheDocument();
    expect(cutGridMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "导出 prompt" }));
    expect(exportGridPromptMock).toHaveBeenCalledWith({
      gridIndex: 4,
      gridType: "sketch",
      modeKey: "2x2_scene",
      beatNumbers: [5, 6],
    });
    expect(await screen.findByText("sketch prompt text")).toBeInTheDocument();
  });
});
