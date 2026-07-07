// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SketchSection } from "@/components/episode/beat-workbench/sketch-section";
import { useAspectRatioStore } from "@/stores/aspect-ratio-store";
import type { Beat } from "@/types/episode";

const markSeenMock = vi.fn();
const stageManifestMock = vi.fn();
const backgroundAnchorsMock = vi.fn();
const updateBackgroundAnchorMock = vi.fn();
const uploadBackgroundAnchorMock = vi.fn();
const directorStatusMock = vi.fn();
const directorConvertMock = vi.fn();
const taskStartMock = vi.fn();
const regenerateSketchMock = vi.fn();
const poolSelectMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      if (key === "episode.beat.noSketch") return "无草图";
      if (key === "common.generateNew") return "生成新图";
      if (key === "common.regenerate") return "重新生成";
      if (key === "episode.workbench.sketch.generateNow") return "立即生成";
      if (key === "episode.workbench.sketch.regenDesc") return `重生第 ${vars?.n} 个 beat`;
      if (key === "episode.workbench.sketch.generateDesc") return `生成第 ${vars?.n} 个 beat`;
      if (key === "episode.workbench.sketch.directorControl") return "导演合成资产";
      if (key === "episode.workbench.sketch.directorControlFile") return "合成图 + 纯背景 + 元数据";
      if (key === "episode.workbench.sketch.convertDirectorControl") return "转草图";
      if (key === "episode.workbench.sketch.convertDirectorStarted") return "已启动";
      if (key === "episode.workbench.sketch.convertDirectorFailed") return "启动失败";
      if (key === "episode.workbench.sketch.openDirectorWorld") return "导演世界";
      if (key === "episode.workbench.sketch.chooseBackground") return "背景";
      if (key === "episode.workbench.sketch.poseEdit") return "姿势编辑";
      if (key === "episode.workbench.sketch.cropEdit") return "裁剪保存";
      return key;
    },
  }),
}));

vi.mock("@/lib/queries/sketches", () => ({
  StalePoolSelectError: class StalePoolSelectError extends Error {},
  usePoolSelect: () => ({ mutateAsync: poolSelectMock, isPending: false }),
  useRegenerateSketches: () => ({ mutateAsync: regenerateSketchMock, isPending: false }),
  useGenerateMissingManualSketches: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUploadBeatImage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBeatDirectorStageManifest: () => stageManifestMock(),
  useBeatBackgroundAnchors: () => backgroundAnchorsMock(),
  useUpdateBeatBackgroundAnchor: () => ({ mutateAsync: updateBackgroundAnchorMock, isPending: false }),
  useUploadBeatBackgroundAnchor: () => ({ mutateAsync: uploadBackgroundAnchorMock, isPending: false }),
  useDirectorControlFrameStatus: () => directorStatusMock(),
  useDirectorControlToSketch: () => ({ mutateAsync: directorConvertMock, isPending: false }),
}));

vi.mock("@/lib/queries/scripts", () => ({
  useScript: () => ({
    data: {
      ok: true,
      data: {
        sketch_colors: {
          "陆辰_青年时期": "#00ffff CYAN",
        },
      },
    },
  }),
}));

vi.mock("@/lib/queries/sketch-settings", () => ({
  useSketchSettings: () => ({
    data: {
      ok: true,
      data: {
        sketch_image_selection: "doubao_seedream-3.0-t2i",
        options: {},
      },
    },
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({
    data: {
      ok: true,
      data: { cost: 1, display: "1 credit" },
    },
  }),
}));

vi.mock("@/lib/queries/characters", () => ({
  useCharacters: () => ({
    data: [{ name: "陆辰" }],
  }),
}));

vi.mock("@/lib/queries/episodes", () => ({
  useEpisodeDetail: () => ({
    data: {
      ok: true,
      data: {
        prop_menu: [
          {
            prop_id: "羊皮笔记本",
            marker_color: "#d4af37 GOLD",
          },
        ],
      },
    },
  }),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({ start: taskStartMock }),
}));

vi.mock("@/hooks/use-now", () => ({
  useNow: () => 1_717_000_000_000,
}));

vi.mock("@/components/episode/beat-workbench/sketch-pose-editor-dialog", () => ({
  SketchPoseEditorDialog: () => null,
}));

vi.mock("@/components/episode/beat-workbench/sketch-crop-dialog", () => ({
  SketchCropDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="sketch-crop-dialog" /> : null,
}));

vi.mock("@/features/viewer-kit/three-d/ThreeDDirectorDialog", () => ({
  ThreeDDirectorDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="three-d-director-dialog" /> : null,
}));

vi.mock("@/stores/seen-pool-store", () => ({
  useSeenPoolStore: (selector: (state: { markSeen: typeof markSeenMock; seen: Record<string, string[]> }) => unknown) =>
    selector({ markSeen: markSeenMock, seen: {} }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    beat_number: 4,
    narration_segment: "发现密室里的书",
    visual_description: "陆辰举着[[强光手电]]翻开[[羊皮笔记本]]",
    sketch_url: "/static/sketches/beat_04.png",
    detected_identities: ["陆辰_青年时期"],
    detected_props: ["羊皮笔记本"],
    ...overrides,
  } as Beat;
}

describe("SketchSection", () => {
  beforeEach(() => {
    useAspectRatioStore.getState().reset();
    regenerateSketchMock.mockReset();
    regenerateSketchMock.mockResolvedValue({
      ok: true,
      scope: "1x1_16-9_sketch__beat_04",
    });
    poolSelectMock.mockReset();
    poolSelectMock.mockResolvedValue({
      ok: true,
      data: {
        beat_num: 4,
        pool_id: "pool-sketch-4",
        image_type: "sketch",
        sketch_url: "/static/sketches/ep001/beat_04.png",
      },
    });
    stageManifestMock.mockReturnValue({
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
    });
    uploadBackgroundAnchorMock.mockReset();
    uploadBackgroundAnchorMock.mockResolvedValue({ ok: true, data: {} });
    backgroundAnchorsMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          can_choose: true,
          current_anchor: "master",
          anchors: [
            { id: "master", label: "master", exists: true, url: "/static/master.png" },
          ],
          error: "",
        },
      },
      isLoading: false,
      refetch: vi.fn(),
    });
    updateBackgroundAnchorMock.mockReset();
    updateBackgroundAnchorMock.mockResolvedValue({
      ok: true,
      data: { current_anchor: "selected_background", anchors: [] },
    });
    directorStatusMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          ready: false,
          url: null,
          scope: "director_control_to_sketch:ep001:beat_04",
        },
      },
      isLoading: false,
    });
    directorConvertMock.mockReset();
    taskStartMock.mockReset();
    directorConvertMock.mockResolvedValue({
      ok: true,
      task_type: "sketch_generation",
      scope: "director_control_to_sketch:ep001:beat_04",
    });
  });

  it("keeps sketch identity, detected props, and local marked props in the right-side info row", () => {
    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getByTitle("陆辰 · 青年时期")).toBeInTheDocument();
    expect(screen.getByText("羊皮笔记本")).toBeInTheDocument();
    expect(screen.getByText("强光手电")).toBeInTheDocument();
  });

  it("displays portrait sketches at the generated 2:3 asset ratio", () => {
    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getByAltText("Beat 4 sketch").parentElement).toHaveStyle({
      aspectRatio: "2 / 3",
    });
  });

  it("does not duplicate a marked prop that AI already detected", () => {
    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getAllByText("羊皮笔记本")).toHaveLength(1);
  });

  it("shows beat Director World and single-beat background actions", () => {
    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getByRole("button", { name: /导演世界/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /背景/ })).toBeEnabled();
  });

  it("promotes a pool-only sketch before opening crop", async () => {
    render(
      <SketchSection
        beat={makeBeat({ sketch_url: "" })}
        project="demo"
        episode={1}
        images={[
          {
            id: "pool-sketch-4",
            type: "sketch",
            mode: "1x1_2-3_sketch",
            grid_index: 0,
            cell_index: 0,
            row: 0,
            col: 0,
            original_beat: 4,
            cell_url: "/static/grids/ep001/pool-sketch-4.png",
            grid_url: "/static/grids/ep001/grid.png",
            grid_path: "grids/ep001/grid.png",
            stale: false,
          },
        ]}
        assignments={{ "4": "pool-sketch-4" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /裁剪保存/ }));

    await waitFor(() =>
      expect(poolSelectMock).toHaveBeenCalledWith({
        beatNum: 4,
        poolId: "pool-sketch-4",
      }),
    );
    expect(screen.getByTestId("sketch-crop-dialog")).toBeInTheDocument();
  });

  it("refetches single-beat backgrounds before opening the dialog", async () => {
    const refetch = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        data: {
          can_choose: true,
          current_anchor: "master",
          anchors: [
            { id: "master", label: "master", exists: true, url: "/static/master.png" },
          ],
          error: "",
        },
      },
    });
    backgroundAnchorsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      refetch,
    });

    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /背景/ }));

    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(await screen.findByText("master")).toBeInTheDocument();
  });

  it("shows director control preview and conversion action when combined frame is ready", () => {
    directorStatusMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          ready: true,
          url: "/static/admin/demo/director_control_frames/ep001/beat_04/combined.png",
          scope: "director_control_to_sketch:ep001:beat_04",
        },
      },
      dataUpdatedAt: 1_717_000_000_123,
      isLoading: false,
    });

    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getByText("导演合成资产")).toBeInTheDocument();
    expect(screen.getByText("合成图 + 纯背景 + 元数据")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /转草图/ })).toBeEnabled();
    expect(screen.getByAltText("Beat 4 Director World control frame")).toHaveAttribute(
      "src",
      "/static/projects/demo/director_control_frames/ep001/beat_04/combined.png?st_v=1717000000123",
    );
  });

  it("does not stack st_v on director control previews that already have a file version", () => {
    directorStatusMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          ready: true,
          url: "/static/admin/demo/director_control_frames/ep001/beat_04/combined.png?v=file-version",
          scope: "director_control_to_sketch:ep001:beat_04",
        },
      },
      dataUpdatedAt: 1_717_000_000_123,
      isLoading: false,
    });

    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getByAltText("Beat 4 Director World control frame")).toHaveAttribute(
      "src",
      "/static/projects/demo/director_control_frames/ep001/beat_04/combined.png?v=file-version",
    );
  });

  it("starts director control conversion with returned task scope", async () => {
    directorStatusMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          ready: true,
          url: "/static/admin/demo/director_control_frames/ep001/beat_04/combined.png",
          scope: "director_control_to_sketch:ep001:beat_04",
        },
      },
      isLoading: false,
    });

    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /转草图/ }));

    await waitFor(() => expect(directorConvertMock).toHaveBeenCalled());
    expect(taskStartMock).toHaveBeenCalledWith({
      scope: "director_control_to_sketch:ep001:beat_04",
    });
  });

  it("downloads the current sketch url when it is not backed by a pool image", () => {
    const originalCreateElement = document.createElement.bind(document);
    const anchor = originalCreateElement("a") as HTMLAnchorElement;
    const clickSpy = vi.spyOn(anchor, "click").mockImplementation(() => {});
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
        if (tagName === "a") return anchor;
        return originalCreateElement(tagName, options);
      }) as typeof document.createElement);

    try {
      render(
        <SketchSection
          beat={makeBeat()}
          project="demo"
          episode={1}
          images={[]}
          assignments={{}}
        />,
      );

      const downloadButton = screen.getByRole("button", { name: "common.download" });
      expect(downloadButton).toBeEnabled();

      fireEvent.click(downloadButton);

      expect(anchor.getAttribute("href")).toBe("/static/sketches/beat_04.png");
      expect(anchor.download).toBe("beat_4_sketch.png");
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      createElementSpy.mockRestore();
      clickSpy.mockRestore();
    }
  });

  it("uses the project aspect for single-beat sketch regeneration", async () => {
    useAspectRatioStore.getState().setOrientation("demo", "landscape");

    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /重新生成/ }));
    fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(regenerateSketchMock).toHaveBeenCalled());
    expect(regenerateSketchMock).toHaveBeenCalledWith({
      beatIndices: [4],
      modeKey: "1x1_16-9_sketch",
    });
  });

  it("shows generate new for the current beat when the beat has no sketch", async () => {
    render(
      <SketchSection
        beat={makeBeat({ sketch_url: "" })}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.queryByRole("button", { name: /重新生成/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /生成新图/ }));
    fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(regenerateSketchMock).toHaveBeenCalledWith({
      beatIndices: [4],
      modeKey: "1x1_2-3_sketch",
    }));
  });
});
