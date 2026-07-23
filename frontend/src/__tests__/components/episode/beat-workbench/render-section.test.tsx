// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { RenderSection } from "@/components/episode/beat-workbench/render-section";
import { useAspectRatioStore } from "@/stores/aspect-ratio-store";
import type { Beat } from "@/types/episode";
import type { PoolImage } from "@/lib/queries/sketches";

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
            cancel: "取消",
            confirm: "确认",
            download: "下载",
            forceUse: "强制使用",
            new: "NEW",
            regenerate: "重新生成",
            upload: "上传",
            loading: "Loading",
          },
          episode: {
            beat: { noRender: "暂无 Render" },
            workbench: {
              render: {
                backgroundTitle: "Render 背景参考",
                backgroundCurrent: "当前：{{label}}",
                backgroundHint: "只给草图上色/材质，不改构图。",
                backgroundMissing: "未找到参考图",
                backgroundOpen360: "打开导演世界",
                backgroundNo360: "无 360",
                backgroundAnchorLabels: {
                  master: "场景正面",
                  reverse: "场景背面",
                  directorEnvOnly: "导演世界场景截图",
                },
                backgroundCropAction: "截图 {{label}}",
                backgroundCropTitle: "{{label}} 裁剪截图",
                backgroundCropFallbackTitle: "裁剪截图",
                backgroundUpload: "上传外部参考",
                backgroundUploaded: "背景已上传",
                backgroundUploadFailed: "背景上传失败",
                backgroundSaved: "背景已切换",
                backgroundSaveFailed: "背景切换失败",
                backgroundCropSave: "保存截图",
                renderCurrentSketch: "Render 当前草图",
                regenDesc: "重生 Beat #{{n}}",
                regenFailed: "重生失败",
                regenStarted: "已启动重生",
                regenTitle: "重新生成？",
                switchFailed: "切换失败",
                switched: "已切换",
                forceFailed: "强制失败",
                forcedUse: "已强制使用",
                versionMismatch: "版本不匹配",
                versionMismatchDesc: "确定使用旧图？",
              },
            },
          },
        },
      },
    },
  });
});

const poolSelectMock: Mock = vi.fn();
const regenerateMock: Mock = vi.fn();
const uploadMock: Mock = vi.fn();
const backgroundAnchorsMock: Mock = vi.fn();
const updateBackgroundAnchorMock: Mock = vi.fn();
const cropBackgroundAnchorMock: Mock = vi.fn();
const uploadBackgroundAnchorMock: Mock = vi.fn();
const taskStartMock: Mock = vi.fn();
const invalidateQueriesMock: Mock = vi.fn();
const generationCreditCostMock: Mock = vi.fn();

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
  };
});

vi.mock("@/lib/queries/sketches", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/sketches")>();
  return {
    ...actual,
    usePoolSelect: () => ({ mutateAsync: poolSelectMock, isPending: false }),
    useBeatBackgroundAnchors: () => backgroundAnchorsMock(),
    useBeatDirectorStageManifest: () => ({
      data: {
        ok: true,
        data: {
          viewer_kind: "three_d_director",
          mode: "beat",
          project: "demo",
          scene_id: "地下室",
          display_name: "地下室",
          source: {
            ply_url: "/static/director_worlds/scene/master_sharp.ply",
            source_kind: "master",
          },
          palette: { actors: [], props: [], anonymous_colors: [] },
          allowed_destinations: ["view", "beat_selected_background"],
        },
      },
      isLoading: false,
    }),
    useUpdateBeatBackgroundAnchor: () => ({
      mutateAsync: updateBackgroundAnchorMock,
      isPending: false,
    }),
    useCropBeatBackgroundAnchor: () => ({
      mutateAsync: cropBackgroundAnchorMock,
      isPending: false,
    }),
    useUploadBeatBackgroundAnchor: () => ({
      mutateAsync: uploadBackgroundAnchorMock,
      isPending: false,
    }),
    useRegenerateRenderBeats: () => ({
      mutateAsync: regenerateMock,
      isPending: false,
    }),
    useUploadBeatImage: () => ({ mutateAsync: uploadMock, isPending: false }),
  };
});

vi.mock("@/lib/queries/render-settings", () => ({
  useRenderSettings: () => ({
    data: {
      ok: true,
      data: {
        render_image_selection: "doubao_seedream-3.0-t2i",
        options: {},
        sketch_aspect_padding: true,
      },
    },
  }),
}));

const scenePlatePreviewState: {
  data: null | {
    render: {
      relight: boolean;
      status: "no_time" | "time_baked" | "relight";
      label: string;
    };
  };
} = { data: null };

vi.mock("@/lib/queries/scenes", () => ({
  useScenePlatePreview: () => ({
    data: scenePlatePreviewState.data
      ? { ok: true, data: scenePlatePreviewState.data }
      : undefined,
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: (...args: unknown[]) => generationCreditCostMock(...args),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    start: taskStartMock,
    started: false,
    stopping: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/features/viewer-kit/three-d/ThreeDDirectorDialog", () => ({
  ThreeDDirectorDialog: ({
    open,
    onSubmitDirectorCombined,
  }: {
    open: boolean;
    onSubmitDirectorCombined?: (blob: Blob, meta: {
      controlFrameBundle?: {
        rel_paths: { combined: string; env_only: string; frame_meta: string };
        urls: { combined: string; env_only: string; frame_meta: string };
      };
      controlFrameRelPath?: string;
    }) => void | Promise<void>;
  }) =>
    open ? (
      <div data-testid="render-director-world-dialog">
        <button
          type="button"
          onClick={() => void onSubmitDirectorCombined?.(new Blob(["x"]), {
            controlFrameBundle: {
              rel_paths: {
                combined: "director_control_frames/ep001/beat_05/combined.png",
                env_only: "director_control_frames/ep001/beat_05/env_only.png",
                frame_meta: "director_control_frames/ep001/beat_05/frame_meta.json",
              },
              urls: {
                combined: "/static/director_control_frames/ep001/beat_05/combined.png",
                env_only: "/static/director_control_frames/ep001/beat_05/env_only.png",
                frame_meta: "/static/director_control_frames/ep001/beat_05/frame_meta.json",
              },
            },
            controlFrameRelPath: "director_control_frames/ep001/beat_05/combined.png",
          })}
        >
          mock submit director combined
        </button>
      </div>
    ) : null,
}));

const beat = {
  beat_number: 5,
  narration_segment: "beat text",
  scene_ref: { scene_id: "卫生间", variant_id: "夜" },
  time_of_day: "白天",
  frame_url: "/static/current-render.png",
} as Beat;

const renderImage: PoolImage = {
  id: "render-5",
  type: "render",
  mode: "2x3_1-1",
  grid_index: 7,
  cell_index: 2,
  row: 0,
  col: 1,
  original_beat: 5,
  cell_url: "/static/render-5.png",
  grid_url: "/static/render-grid.png",
  cell_path: "render/beat_05.png",
  grid_path: "custom/render_grid.png",
  generated_at: "2026-05-16T09:00:00Z",
  stale: false,
  beat_content_hash: "hash-5",
};

const sketchImage: PoolImage = {
  id: "sketch-5",
  type: "sketch",
  mode: "2x3_1-1",
  grid_index: 7,
  cell_index: 2,
  row: 0,
  col: 1,
  original_beat: 5,
  cell_url: "/static/sketch-5.png",
  grid_url: "/static/sketch-grid.png",
  cell_path: "sketch/beat_05.png",
  grid_path: "custom/sketch_grid.png",
  generated_at: "2026-05-16T08:00:00Z",
  stale: false,
};

const newerRenderImage: PoolImage = {
  ...renderImage,
  id: "render-5-newer",
  cell_url: "/static/render-5-newer.png",
  cell_path: "render/beat_05_newer.png",
  generated_at: "2026-05-16T10:00:00Z",
};

beforeEach(() => {
  useAspectRatioStore.getState().reset();
  poolSelectMock.mockReset();
  regenerateMock.mockReset();
  uploadMock.mockReset();
  backgroundAnchorsMock.mockReset();
  backgroundAnchorsMock.mockReturnValue({
    isLoading: false,
    data: {
      ok: true,
      data: {
        episode: 1,
        beat_num: 5,
        scene_id: "地下室",
        can_choose: true,
        current_anchor: "master",
        render_anchor_id: "selected_background",
        current_reference: {
          id: "master",
          label: "master",
          url: "/static/selected-background.png",
          path: "/tmp/selected-background.png",
        },
        anchors: [
          {
            id: "director_env_only",
            label: "director env_only",
            current: false,
            exists: true,
            url: "/static/director-env.png",
            path: "/tmp/director-env.png",
          },
          {
            id: "master",
            label: "master",
            current: true,
            exists: true,
            url: "/static/master.png",
            path: "/tmp/master.png",
          },
          {
            id: "reverse",
            label: "reverse",
            current: false,
            exists: true,
            url: "/static/reverse.png",
            path: "/tmp/reverse.png",
          },
          {
            id: "selected_background",
            label: "截图/上传",
            current: true,
            exists: true,
            url: "/static/selected-background.png",
            path: "/tmp/selected-background.png",
          },
        ],
        error: "",
      },
    },
  });
  updateBackgroundAnchorMock.mockReset();
  updateBackgroundAnchorMock.mockResolvedValue({ ok: true });
  cropBackgroundAnchorMock.mockReset();
  cropBackgroundAnchorMock.mockResolvedValue({ ok: true });
  uploadBackgroundAnchorMock.mockReset();
  uploadBackgroundAnchorMock.mockResolvedValue({ ok: true });
  taskStartMock.mockReset();
  invalidateQueriesMock.mockReset();
  generationCreditCostMock.mockReset();
  generationCreditCostMock.mockReturnValue({
    data: {
      ok: true,
      data: { cost: 1, display: "1 credit" },
    },
  });
  scenePlatePreviewState.data = null;
});

describe("RenderSection", () => {
  it("does not expose removed render detail or bad-image analysis actions", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <RenderSection
          beat={beat}
          project="demo"
          episode={1}
          images={[renderImage, sketchImage]}
          assignments={{ "5": "render-5" }}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: "详情" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "坏图分析" })).not.toBeInTheDocument();
  });

  it("shows render relight state next to render actions", () => {
    scenePlatePreviewState.data = {
      render: {
        relight: true,
        status: "relight",
        label: "Render：将使用 卫生间_夜，relight 到 白天",
      },
    };

    render(
      <I18nextProvider i18n={i18n}>
        <RenderSection
          beat={beat}
          project="demo"
          episode={1}
          images={[renderImage, sketchImage]}
          assignments={{ "5": "render-5" }}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText("Relight 到 白天")).toBeInTheDocument();
    expect(screen.getByTitle("Relight：按 beat 时间重新打光，不改变场景结构。")).toBeInTheDocument();
    expect(screen.queryByText(/Seedance2/)).not.toBeInTheDocument();
  });

  it("shows locked-light state when render will not relight", () => {
    scenePlatePreviewState.data = {
      render: {
        relight: false,
        status: "time_baked",
        label: "Render：将使用 卫生间_夜，锁图光",
      },
    };

    render(
      <I18nextProvider i18n={i18n}>
        <RenderSection
          beat={beat}
          project="demo"
          episode={1}
          images={[renderImage, sketchImage]}
          assignments={{ "5": "render-5" }}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText("锁图光")).toBeInTheDocument();
  });

  it("resolves current render assignments stored as cell paths and previews canonical frame", async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <RenderSection
          beat={beat}
          project="demo"
          episode={1}
          images={[newerRenderImage, renderImage, sketchImage]}
          assignments={{ "5": "render/beat_05.png" }}
        />
      </I18nextProvider>,
    );

    expect(screen.getByAltText("Beat 5 render")).toHaveAttribute(
      "src",
      "/static/current-render.png",
    );

    const activeCandidate = screen.getByRole("button", { name: /✓/ });
    expect(activeCandidate.querySelector("img")).toHaveAttribute("src", "/static/render-5.png");
  });


  it("selects the default master background before single render regeneration", async () => {
    const user = userEvent.setup();
    regenerateMock.mockResolvedValue({ ok: true, scope: "render-scope" });
    backgroundAnchorsMock.mockReturnValue({
      isLoading: false,
      data: {
        ok: true,
        data: {
          episode: 1,
          beat_num: 5,
          scene_id: "地下室",
          can_choose: true,
          current_anchor: "",
          render_anchor_id: "",
          current_reference: null,
          anchors: [
            {
              id: "master",
              label: "master",
              current: false,
              exists: true,
              url: "/static/master.png",
              path: "/tmp/master.png",
            },
          ],
          error: "",
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <RenderSection
          beat={beat}
          project="demo"
          episode={1}
          images={[renderImage, sketchImage]}
          assignments={{ "5": "render-5" }}
        />
      </I18nextProvider>,
    );

    await user.click(screen.getByRole("button", { name: /重新生成/ }));
    await user.click(screen.getByRole("button", { name: "确认" }));

    expect(updateBackgroundAnchorMock).toHaveBeenCalledWith({ anchorId: "master" });
    expect(regenerateMock).toHaveBeenCalledWith({
      beatIndices: [5],
      imageGenerationSelection: "doubao_seedream-3.0-t2i",
      modeKey: "1x1_2-3",
    });
    expect(
      updateBackgroundAnchorMock.mock.invocationCallOrder[0],
    ).toBeLessThan(regenerateMock.mock.invocationCallOrder[0]);
  });

  it("uses the landscape project aspect for single render regeneration and credit cost", async () => {
    const user = userEvent.setup();
    useAspectRatioStore.getState().setOrientation("demo", "landscape");
    regenerateMock.mockResolvedValue({ ok: true, scope: "render-scope" });

    render(
      <I18nextProvider i18n={i18n}>
        <RenderSection
          beat={beat}
          project="demo"
          episode={1}
          images={[renderImage, sketchImage]}
          assignments={{ "5": "render-5" }}
        />
      </I18nextProvider>,
    );

    expect(generationCreditCostMock).toHaveBeenCalledWith(
      "feature",
      "mainline.render_regen",
      {
        surface: "supertale",
        imageRole: "render",
        modeKey: "1x1_16-9",
        params: { image_selection: "doubao_seedream-3.0-t2i" },
      },
    );

    await user.click(screen.getByRole("button", { name: /重新生成/ }));
    await user.click(screen.getByRole("button", { name: "确认" }));

    expect(regenerateMock).toHaveBeenCalledWith({
      beatIndices: [5],
      imageGenerationSelection: "doubao_seedream-3.0-t2i",
      modeKey: "1x1_16-9",
    });
  });

  it("prefers the source sketch aspect over the project aspect", async () => {
    const user = userEvent.setup();
    useAspectRatioStore.getState().setOrientation("demo", "landscape");
    regenerateMock.mockResolvedValue({ ok: true, scope: "render-scope" });
    class MockImage {
      naturalWidth = 1200;
      naturalHeight = 1800;
      onload: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", MockImage);

    try {
      render(
        <I18nextProvider i18n={i18n}>
          <RenderSection
            beat={{ ...beat, sketch_url: "/static/current-sketch.png" }}
            project="demo"
            episode={1}
            images={[renderImage, sketchImage]}
            assignments={{ "5": "render-5" }}
          />
        </I18nextProvider>,
      );

      await waitFor(() =>
        expect(generationCreditCostMock).toHaveBeenLastCalledWith(
          "feature",
          "mainline.render_regen",
          {
            surface: "supertale",
            imageRole: "render",
            modeKey: "1x1_2-3",
            params: { image_selection: "doubao_seedream-3.0-t2i" },
          },
        ),
      );

      await user.click(screen.getByRole("button", { name: /重新生成/ }));
      await user.click(screen.getByRole("button", { name: "确认" }));

      expect(regenerateMock).toHaveBeenCalledWith({
        beatIndices: [5],
        imageGenerationSelection: "doubao_seedream-3.0-t2i",
        modeKey: "1x1_2-3",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows render background reference controls and renders current sketch", async () => {
    const user = userEvent.setup();
    regenerateMock.mockResolvedValue({ ok: true, scope: "render-scope" });
    render(
      <I18nextProvider i18n={i18n}>
        <RenderSection
          beat={beat}
          project="demo"
          episode={1}
          images={[renderImage, sketchImage]}
          assignments={{ "5": "render-5" }}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText("Render 背景参考")).toBeInTheDocument();
    expect(screen.getByAltText("Beat 5 render").parentElement).toHaveStyle({
      aspectRatio: "2 / 3",
    });
    expect(screen.getByText("当前：场景正面")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "无 360" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导演世界场景截图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "场景正面" })).toHaveClass("bg-primary/[0.075]");
    expect(screen.getByRole("button", { name: "场景正面" })).toHaveClass("border-primary/45");
    const reverseButton = screen.getByRole("button", { name: "场景背面" });
    const uploadButton = screen.getByRole("button", { name: "上传外部参考" });
    const anchorRow = reverseButton.parentElement?.parentElement;
    expect(anchorRow).toContainElement(uploadButton);
    expect(
      reverseButton.compareDocumentPosition(uploadButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "截图/上传" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开导演世界" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开导演世界" }));
    expect(screen.getByTestId("render-director-world-dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "场景背面" }));
    expect(updateBackgroundAnchorMock).toHaveBeenCalledWith({ anchorId: "reverse" });

    await user.click(screen.getByRole("button", { name: "截图 场景正面" }));
    expect(screen.getByRole("heading", { name: "场景正面 裁剪截图" })).toBeInTheDocument();
    expect(screen.getByText("裁剪 2:3")).toBeInTheDocument();
    expect(cropBackgroundAnchorMock).not.toHaveBeenCalled();

    const cropImage = screen.getByAltText("场景正面 裁剪截图");
    Object.defineProperty(cropImage, "naturalWidth", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(cropImage, "naturalHeight", {
      configurable: true,
      value: 900,
    });
    fireEvent.load(cropImage);
    Object.defineProperty(cropImage, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1200,
        bottom: 900,
        width: 1200,
        height: 900,
        toJSON: () => {},
      }),
    });

    const cropBox = screen.getByLabelText("移动裁剪区域");
    fireEvent.pointerDown(cropBox, { pointerId: 1, clientX: 600, clientY: 450 });
    fireEvent.pointerMove(cropBox, { pointerId: 1, clientX: 660, clientY: 450 });
    fireEvent.pointerUp(cropBox, { pointerId: 1 });

    await user.click(screen.getByRole("button", { name: "保存截图" }));
    expect(cropBackgroundAnchorMock).toHaveBeenCalledWith({
      anchorId: "master",
      crop: { x: 360, y: 0, width: 600, height: 900 },
    });

    expect(screen.queryByRole("button", { name: "Render 当前草图" })).not.toBeInTheDocument();
    expect(regenerateMock).not.toHaveBeenCalled();
    expect(taskStartMock).not.toHaveBeenCalled();
  });

  it("uses the landscape project aspect for render background crops", async () => {
    const user = userEvent.setup();
    useAspectRatioStore.getState().setOrientation("demo", "landscape");

    render(
      <I18nextProvider i18n={i18n}>
        <RenderSection
          beat={beat}
          project="demo"
          episode={1}
          images={[renderImage, sketchImage]}
          assignments={{ "5": "render-5" }}
        />
      </I18nextProvider>,
    );

    await user.click(screen.getByRole("button", { name: "截图 场景正面" }));

    expect(screen.getByText("裁剪 16:9")).toBeInTheDocument();
  });

  it("uses current source instead of selected background slot for active render background", () => {
    backgroundAnchorsMock.mockReturnValue({
      isLoading: false,
      data: {
        ok: true,
        data: {
          episode: 1,
          beat_num: 5,
          scene_id: "地下室",
          can_choose: true,
          current_anchor: "selected_background",
          current_source: "master",
          render_anchor_id: "selected_background",
          current_reference: {
            id: "selected_background",
            label: "截图/上传",
            url: "/static/selected-background.png",
            path: "/tmp/selected-background.png",
          },
          display_reference: {
            id: "master",
            label: "master",
            url: "/static/master.png",
            path: "/tmp/master.png",
          },
          render_input: {
            id: "selected_background",
            label: "selected_background",
            url: "/static/selected-background.png",
            path: "/tmp/selected-background.png",
          },
          anchors: [
            {
              id: "master",
              label: "master",
              current: false,
              exists: true,
              url: "/static/master.png",
              path: "/tmp/master.png",
            },
            {
              id: "selected_background",
              label: "截图/上传",
              current: true,
              exists: true,
              url: "/static/selected-background.png",
              path: "/tmp/selected-background.png",
            },
          ],
          error: "",
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <RenderSection
          beat={beat}
          project="demo"
          episode={1}
          images={[renderImage, sketchImage]}
          assignments={{ "5": "render-5" }}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText("当前：场景正面")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "场景正面" })).toHaveClass("bg-primary/[0.075]");
    expect(screen.getByRole("button", { name: "场景正面" })).toHaveClass("border-primary/45");
    expect(screen.queryByRole("button", { name: "截图/上传" })).not.toBeInTheDocument();
  });

  it("refreshes the shared director control frame query after committing from render", async () => {
    const user = userEvent.setup();

    render(
      <I18nextProvider i18n={i18n}>
        <RenderSection
          beat={beat}
          project="demo"
          episode={1}
          images={[renderImage, sketchImage]}
          assignments={{ "5": "render-5" }}
        />
      </I18nextProvider>,
    );

    await user.click(screen.getByRole("button", { name: "打开导演世界" }));
    await user.click(screen.getByRole("button", { name: "mock submit director combined" }));

    await waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: ["projects", "demo", "episodes", 1, "beats", 5, "director-control-frame"],
      });
    });
  });
});
