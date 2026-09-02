// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThreeDDirectorDialog } from "@/features/viewer-kit/three-d/ThreeDDirectorDialog";
import type {
  DirectorFrameMetaProp,
  DirectorStageManifest,
} from "@/features/viewer-kit/three-d/directorManifest";
import {
  generateAiStagingProp,
  getBeatDirectorStageOverlay,
  saveBeatDirectorControlFrame,
  saveBeatDirectorStageOverlay,
} from "@/api/viewerManifests";

const viewerMock = vi.hoisted(() => ({
  hasCollision: vi.fn(() => true),
  axesGrid: { setVisible: vi.fn() },
  setCollisionVisible: vi.fn(),
  fly: { setSpeedScale: vi.fn() },
  resetCamera: vi.fn(),
  getSourceTransform: vi.fn(() => ({
    xOffset: 0,
    yOffset: 0,
    zOffset: 0,
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    scale: 1,
  })),
  setSourceTransform: vi.fn(),
  resetSourceTransform: vi.fn(),
  nudgeWorldYOffset: vi.fn(),
  getWorldYOffset: vi.fn(() => 0),
  fitView: vi.fn(),
  cameraBehindSelected: vi.fn(),
  cameraFaceSelected: vi.fn(),
  lookAtSelected: vi.fn(),
  setSelectedPose: vi.fn(),
  setSelectedShapeHint: vi.fn(),
  setSelectedLabel: vi.fn(),
  nudgeSelected: vi.fn(),
  scaleSelected: vi.fn(),
  moveSelectedToCrosshair: vi.fn(),
  mountSelectedAtCrosshair: vi.fn(),
  unmountSelected: vi.fn(),
  isSelectedMounted: vi.fn(() => false),
  groundSelected: vi.fn(),
  rotateSelected: vi.fn(),
  deleteSelected: vi.fn(),
  clearMarkers: vi.fn(),
  clearSelection: vi.fn(),
  selectAtCrosshair: vi.fn(),
  getCrosshairTarget: vi.fn(() => ({ kind: "surface", position: [0, 0, 0], source: "test" })),
  cycleSelection: vi.fn(),
  placeMarker: vi.fn(),
  captureScreenshot: vi.fn(),
  exportSceneSnapshot: vi.fn(),
  loadSceneSnapshot: vi.fn(),
  getMarkerLabels: vi.fn(() => []),
  getSelectionScreenPosition: vi.fn(() => ({ x: 100, y: 100, visible: true })),
  onMarkersChange: vi.fn((listener) => {
    listener({ actor: 1, prop: 1, staging: 0 });
    return () => undefined;
  }),
  onSelectionChange: vi.fn((listener) => {
    listener({
      kind: "actor",
      index: 0,
      label: "陆辰",
      position: [1, 2, 3],
      pose: "standing",
      actionPlaying: true,
      mounted: false,
      shapeHint: null,
    });
    return () => undefined;
  }),
}));

vi.mock("@/features/viewer-kit/three-d/ThreeDStageCanvas", () => ({
  ThreeDStageCanvas: ({
    splatUrl,
    panoUrl,
    collisionUrl,
    orientationMode,
    interactionActive,
    onInteractionActiveChange,
    onLoadProgress,
    onReady,
    onSourceReady,
  }: {
    splatUrl: string | null;
    panoUrl?: string | null;
    collisionUrl?: string | null;
    orientationMode?: string;
    interactionActive?: boolean;
    onInteractionActiveChange?: (active: boolean) => void;
    onLoadProgress?: (progress: {
      phase: "loading" | "ready" | "error";
      percent: number | null;
      loadedBytes: number;
      totalBytes: number | null;
      gaussians: number | null;
      message: string | null;
    }) => void;
    onReady?: (viewer: unknown) => void;
    onSourceReady?: () => void;
  }) => {
    const readyKeyRef = useRef("");
    useEffect(() => {
      const readyKey = `${splatUrl ?? ""}|${panoUrl ?? ""}|${orientationMode ?? ""}`;
      if (readyKeyRef.current === readyKey) return;
      readyKeyRef.current = readyKey;
      onReady?.(viewerMock);
      onLoadProgress?.({
        phase: "ready",
        percent: 100,
        loadedBytes: 0,
        totalBytes: null,
        gaussians: null,
        message: null,
      });
      onSourceReady?.();
    }, [orientationMode, panoUrl, splatUrl]);
    return (
      <div>
        <div
          data-testid="stage-canvas"
          data-splat-url={splatUrl ?? ""}
          data-pano-url={panoUrl ?? ""}
          data-collision-url={collisionUrl ?? ""}
          data-orientation-mode={orientationMode ?? ""}
          data-active={interactionActive ? "true" : "false"}
        />
        {!interactionActive && (
          <button type="button" onClick={() => onInteractionActiveChange?.(true)}>
            点击进入导演世界
          </button>
        )}
      </div>
    );
  },
}));

vi.mock("@/features/viewer-kit/pano/PanoCaptureSurface", () => ({
  PanoCaptureSurface: ({
    manifest,
    captureLabel,
    onCapture,
  }: {
    manifest: {
      source: { url: string; slot_kind: "scene_director_pano_360" | "scene_360_candidate" };
    };
    captureLabel: string;
    onCapture: (result: {
      blob: Blob;
      width: number;
      height: number;
      aspect: "16:9";
      yaw_deg: number;
      pitch_deg: number;
      fov_deg: number;
      crop: {
        x: number;
        y: number;
        width: number;
        height: number;
        coordinate_space: "viewer_canvas";
      };
      source: { url: string; slot_kind: "scene_director_pano_360" | "scene_360_candidate" };
    }) => void | Promise<void>;
  }) => (
    <div data-testid="pano-capture-surface" data-pano-url={manifest.source.url}>
      <button
        type="button"
        onClick={() =>
          onCapture({
            blob: new Blob(["pano"], { type: "image/png" }),
            width: 640,
            height: 360,
            aspect: "16:9",
            yaw_deg: 42,
            pitch_deg: -3,
            fov_deg: 70,
            crop: {
              x: 0,
              y: 0,
              width: 640,
              height: 360,
              coordinate_space: "viewer_canvas",
            },
            source: manifest.source,
          })
        }
      >
        {captureLabel}
      </button>
    </div>
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/api/viewerManifests", () => ({
  generateAiStagingProp: vi.fn(async () => ({
    prop: {
      prop_id: "horse_mount",
      name: "可骑的马",
      marker_color: "#7c3aed",
      shape_hint: "quadruped_mount",
      scale: [1.4, 1.25, 2.2],
      position: [1, 0, 2],
    },
  })),
  getBeatDirectorStageOverlay: vi.fn(async () => ({
    status: "missing",
    overlay: null,
    path: "/tmp/director_blockings/ep001/beat_03.json",
    same_scene_beats: [{ beat: 3, label: "Beat 3", scene_id: "地下室" }],
  })),
  saveBeatDirectorStageOverlay: vi.fn(async (_project, _episode, beat, payload) => ({
    status: "saved",
    overlay: payload,
    path: `/tmp/director_blockings/ep001/beat_${String(beat).padStart(2, "0")}.json`,
    same_scene_beats: [{ beat, label: `Beat ${beat}`, scene_id: "地下室" }],
  })),
  saveBeatDirectorControlFrame: vi.fn(async () => ({
    dir: "/tmp/director_control_frames/ep001/beat_03",
    paths: {
      combined: "/tmp/director_control_frames/ep001/beat_03/combined.png",
      env_only: "/tmp/director_control_frames/ep001/beat_03/env_only.png",
      frame_meta: "/tmp/director_control_frames/ep001/beat_03/frame_meta.json",
    },
    rel_paths: {
      combined: "director_control_frames/ep001/beat_03/combined.png",
      env_only: "director_control_frames/ep001/beat_03/env_only.png",
      frame_meta: "director_control_frames/ep001/beat_03/frame_meta.json",
    },
    urls: {
      combined: "/static/projects/demo/director_control_frames/ep001/beat_03/combined.png",
      env_only: "/static/projects/demo/director_control_frames/ep001/beat_03/env_only.png",
      frame_meta: "/static/projects/demo/director_control_frames/ep001/beat_03/frame_meta.json",
    },
  })),
  startDirectorControlToSketch: vi.fn(async () => ({
    task_type: "sketch_generation",
    scope: "director_control_to_sketch:ep001:beat_03",
    message: "started",
  })),
}));

const manifest: DirectorStageManifest = {
  viewer_kind: "three_d_director",
  mode: "beat",
  project: "demo",
  scene_id: "地下室",
  display_name: "地下室",
  source: {
    ply_url: "/static/demo/world.sog",
    source_kind: "master",
  },
  source_options: [
    {
      kind: "active",
      label: "active",
      ply_url: "/static/demo/world.sog",
    },
    {
      kind: "reverse",
      label: "reverse",
      ply_url: "/static/demo/reverse.sog",
    },
  ],
  source_orientation_mode: "supersplat_auto",
  blockings_dir_fs: "/@fs/demo/director_blockings/ep001",
  control_frames_dir_fs: "/@fs/demo/director_control_frames",
  slate_beat: 3,
  beat_context: {
    episode: 1,
    beat: 3,
    detected_identities: [],
    detected_props: [],
  },
  palette: {
    actors: [],
    props: [],
    anonymous_colors: [],
    anonymous_prop_colors: ["#B71C1C", "#6D4C41"],
  },
  allowed_destinations: ["view", "download", "beat_selected_background"],
};

describe("ThreeDDirectorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBeatDirectorStageOverlay).mockResolvedValue({
      status: "missing",
      overlay: null,
      path: "/tmp/director_blockings/ep001/beat_03.json",
      same_scene_beats: [{ beat: 3, label: "Beat 3", scene_id: "地下室" }],
    });
    viewerMock.captureScreenshot.mockReturnValue(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    );
    viewerMock.exportSceneSnapshot.mockReturnValue({
      schemaVersion: 1,
      savedAt: 1,
      actors: [],
      props: [],
      stagings: [],
      camera: { azim: 0, elev: 0, distance: 1, focalPoint: [0, 0, 0] },
    });
  });
  it("overrides the base small-dialog max width at the sm breakpoint", () => {
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-none");
  });

  it("uses the full viewport instead of a centered floating dialog", () => {
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("h-dvh");
    expect(dialog).toHaveClass("w-dvw");
    expect(dialog).toHaveClass("rounded-none");
  });

  it("uses only the immersive viewer close control", () => {
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("opens a blank Director World when the Director World manifest is missing", async () => {
    const onOpenChange = vi.fn();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={onOpenChange}
        manifest={null}
        title="Beat 3 导演世界"
        description="同源加载 Beat 导演世界。"
      />,
    );

    expect(screen.getAllByText("Beat 3 导演世界").length).toBeGreaterThan(0);
    expect(screen.queryByText("暂无导演世界 manifest")).not.toBeInTheDocument();
    expect(screen.queryByText(/还没有可用的导演世界资产/)).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /emptySource|无来源/ })).toBeInTheDocument();
  });

  it("blocks beat actor and prop creation when assigned colors are missing", async () => {
    const user = userEvent.setup();
    const beatManifest: DirectorStageManifest = {
      ...manifest,
      mode: "beat",
      beat_context: {
        episode: 1,
        beat: 3,
        detected_identities: ["陆辰"],
        detected_props: ["手电筒"],
      },
      palette: {
        actors: [],
        props: [],
        anonymous_colors: [],
        anonymous_prop_colors: ["#B71C1C", "#6D4C41"],
      },
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={beatManifest}
      />,
    );

    expect(screen.getByText("没有拿到已分配的人物颜色，不能创建人物。请先在主线镜头里完成颜色分配。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "把人物放到准星" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /道具/ }));
    expect(screen.getByText("没有拿到已分配的道具颜色，不能创建道具。请先在主线镜头里完成颜色分配。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "把人物放到准星" })).toBeDisabled();
    expect(viewerMock.placeMarker).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /AI 占位/ }));
    await user.click(screen.getByRole("button", { name: "#6D4C41" }));
    await user.type(screen.getByLabelText("占位名"), "雨棚");
    await user.click(screen.getByRole("button", { name: "本地占位" }));
    expect(viewerMock.placeMarker).toHaveBeenLastCalledWith("staging", {
      color: "#6D4C41",
      label: "雨棚",
    });
  });

  it("does not blur the full Freezone canvas behind the WebGL viewer", () => {
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "supports-backdrop-filter:backdrop-blur-none",
    );
  });

  it("marks the app as immersive so the heavy canvas behind the viewer can stop painting", () => {
    const { unmount } = render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    expect(document.body).toHaveClass("st-viewer-immersive-active");

    unmount();
    expect(document.body).not.toHaveClass("st-viewer-immersive-active");
  });

  it("does not stretch the frame guide away from the selected aspect ratio", () => {
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    const label = screen.getAllByText("16:9").find((node) => node.tagName === "DIV");
    const frame = label?.parentElement;
    expect(frame).toBeTruthy();
    expect(frame).not.toHaveClass("h-full");
    expect(frame).not.toHaveClass("w-full");
    expect(frame).toHaveStyle({ aspectRatio: "16 / 9" });
  });

  it("shows the director world sidebar title without legacy beat metadata", () => {
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    expect(screen.getByTestId("director-world-panel-title")).toBeInTheDocument();
    expect(screen.queryByText("EP1 / Beat 3")).not.toBeInTheDocument();
    expect(screen.queryByText("source master")).not.toBeInTheDocument();
    expect(screen.queryByText("slate beat 3")).not.toBeInTheDocument();
    expect(screen.queryByText(/director_blockings\/ep001/)).not.toBeInTheDocument();
    expect(screen.queryByText(/director_control_frames/)).not.toBeInTheDocument();
  });

  it("loads and applies the current beat overlay when the 3GS world opens", async () => {
    vi.mocked(getBeatDirectorStageOverlay).mockResolvedValueOnce({
      status: "current",
      overlay: {
        schema_version: "director_stage_overlay_v1",
        scene_id: "地下室",
        episode: 1,
        beat: 99,
        frame_aspect: "2:3",
        snapshot: {
          schemaVersion: 1,
          savedAt: 2,
          actors: [{ label: "陆辰", color: "#38bdf8", position: [1, 0, 2], yawDeg: 0, scale: [1, 1, 1] }],
          props: [],
          stagings: [],
          camera: { azim: 1, elev: 2, distance: 3, focalPoint: [0, 0, 0] },
        },
      },
      path: "/tmp/director_blockings/ep001/beat_03.json",
      same_scene_beats: [
        { beat: 1, label: "Beat 1", scene_id: "地下室" },
        { beat: 3, label: "Beat 3", scene_id: "地下室" },
      ],
    });

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await waitFor(() => {
      expect(getBeatDirectorStageOverlay).toHaveBeenCalledWith("demo", 1, 3);
      expect(viewerMock.loadSceneSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          actors: expect.arrayContaining([expect.objectContaining({ label: "陆辰" })]),
        }),
      );
      expect(viewerMock.loadSceneSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getAllByText("2:3").length).toBeGreaterThan(0);
  });

  it("restores the saved beat overlay source before applying its snapshot", async () => {
    vi.mocked(getBeatDirectorStageOverlay).mockResolvedValueOnce({
      status: "current",
      overlay: {
        schema_version: "director_stage_overlay_v1",
        scene_id: "地下室",
        episode: 1,
        beat: 3,
        frame_aspect: "16:9",
        source: {
          source_id: "director_pano",
          source_type: "pano360",
          source_kind: "pano",
          pano_url: "/static/demo/director_pano.png",
        },
        snapshot: {
          schemaVersion: 1,
          savedAt: 2,
          actors: [],
          props: [],
          stagings: [],
          camera: { azim: 12, elev: -4, distance: 6, focalPoint: [0, 1, 0] },
        },
      },
      path: "/tmp/director_blockings/ep001/beat_03.json",
      same_scene_beats: [{ beat: 3, label: "Beat 3", scene_id: "地下室" }],
    });

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={{
          ...manifest,
          sources: [
            {
              id: "master_sog",
              source_type: "sog",
              source_kind: "master",
              label: "Master SOG",
              ply_url: "/static/demo/master.sog",
            },
            {
              id: "director_pano",
              source_type: "pano360",
              source_kind: "pano",
              label: "Director Pano",
              pano_url: "/static/demo/director_pano.png",
            },
          ],
          active_source_id: "master_sog",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("stage-canvas")).toHaveAttribute(
        "data-pano-url",
        "/static/demo/director_pano.png",
      );
      expect(viewerMock.loadSceneSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          world: { activeSourceId: "director_pano" },
        }),
      );
    });
  });

  it("uses beat overlay saving instead of local world saving in beat mode", () => {
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
        onSaveScene={() => undefined}
        onClearScene={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "保存此镜头导演状态" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存导演世界" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清空保存" })).not.toBeInTheDocument();
  });

  it("lets scene users switch explicit 3GS source without showing active alias", async () => {
    const user = userEvent.setup();
    const sceneManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      blockings_dir_fs: undefined,
      control_frames_dir_fs: undefined,
      slate_beat: undefined,
      source: {
        ply_url: "/static/demo/world.sog",
        collision_glb_url: "/static/demo/fallback-collision.glb",
        source_kind: "master",
      },
      source_options: [
        { kind: "active", label: "active", ply_url: "/static/demo/world.sog" },
        { kind: "master", label: "master", ply_url: "/static/demo/master.sog" },
        { kind: "reverse", label: "reverse", ply_url: "/static/demo/reverse.sog" },
        { kind: "pano", label: "pano", ply_url: "/static/demo/pano.sog" },
        { kind: "uploaded", label: "uploaded", ply_url: "/static/demo/uploaded.sog" },
      ],
    };
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={sceneManifest}
      />,
    );

    expect(screen.getByRole("option", { name: "正面世界" })).toHaveProperty("selected", true);
    expect(screen.queryByRole("option", { name: "active" })).not.toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("世界来源"),
      screen.getByRole("option", { name: "背面世界" }),
    );
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute(
      "data-splat-url",
      "/static/demo/reverse.sog",
    );
  });

  it("deduplicates manifest source aliases in Director World sources", () => {
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={{
          ...manifest,
          sources: [
            {
              id: "manifest-master",
              source_type: "sog",
              source_kind: "master",
              label: "master",
              ply_url: "/static/demo/master.sog",
              current: true,
            },
            {
              id: "option-master",
              source_type: "sog",
              source_kind: "master",
              label: "master",
              ply_url: "/static/demo/master.sog",
            },
            {
              id: "option-pano",
              source_type: "sog",
              source_kind: "pano",
              label: "pano",
              ply_url: "/static/demo/pano.sog",
            },
            {
              id: "scene-pano",
              source_type: "pano360",
              source_kind: "pano",
              label: "360",
              pano_url: "/static/demo/pano.png",
            },
          ],
        }}
      />,
    );

    const options = Array.from(
      screen.getByLabelText("世界来源").querySelectorAll("option"),
    ).map((option) => option.textContent);
    expect(options).toEqual(["正面世界", "360 世界", "360 · 360图", "无来源"]);
  });

  it("offers an empty Director World source with no splat or pano URL", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    const picker = screen.getByLabelText("世界来源");
    expect(screen.getByRole("option", { name: "无来源" })).toBeInTheDocument();

    await user.selectOptions(
      picker,
      screen.getByRole("option", { name: "无来源" }),
    );

    expect(screen.getByTestId("stage-canvas")).toHaveAttribute("data-splat-url", "");
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute("data-pano-url", "");
  });

  it("routes freezone canvas screenshots through the explicit canvas destination", async () => {
    const user = userEvent.setup();
    const onCaptureCanvasNode = vi.fn();
    const freezoneManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      blockings_dir_fs: undefined,
      control_frames_dir_fs: undefined,
      slate_beat: undefined,
      allowed_destinations: ["view", "download", "canvas_screenshot_node"],
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={freezoneManifest}
        viewerPurpose="freezone"
        onCaptureCanvasNode={onCaptureCanvasNode}
      />,
    );

    expect(screen.getByTestId("director-world-panel-title")).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("世界来源"),
      screen.getByRole("option", { name: "背面世界" }),
    );
    await user.click(screen.getByRole("button", { name: "输出到画布节点" }));

    expect(onCaptureCanvasNode).toHaveBeenCalledTimes(1);
    expect(viewerMock.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ renderMode: "combined", frameAspect: "16:9" }));
    expect(onCaptureCanvasNode.mock.calls[0][1]).toMatchObject({
      kind: "combined",
      source: {
        ply_url: "/static/demo/reverse.sog",
        source_kind: "reverse",
      },
      snapshot: { camera: { focalPoint: [0, 0, 0] } },
    });
  });

  it("ignores duplicate canvas output triggers while a capture is already running", async () => {
    const onCaptureCanvasNode = vi.fn(() => new Promise<void>(() => undefined));
    const freezoneManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      blockings_dir_fs: undefined,
      control_frames_dir_fs: undefined,
      slate_beat: undefined,
      allowed_destinations: ["view", "download", "canvas_screenshot_node"],
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={freezoneManifest}
        viewerPurpose="freezone"
        onCaptureCanvasNode={onCaptureCanvasNode}
      />,
    );

    const outputButton = screen.getByRole("button", { name: "输出到画布节点" });
    fireEvent.click(outputButton);
    fireEvent.click(outputButton);

    await waitFor(() => {
      expect(onCaptureCanvasNode).toHaveBeenCalledTimes(1);
    });
  });

  it("passes combined env_only and frame_meta in canvas output meta", async () => {
    const user = userEvent.setup();
    const onCaptureCanvasNode = vi.fn();
    const freezoneManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      blockings_dir_fs: undefined,
      control_frames_dir_fs: undefined,
      slate_beat: undefined,
      allowed_destinations: ["view", "download", "canvas_screenshot_node"],
    };
    viewerMock.exportSceneSnapshot.mockReturnValueOnce({
      schemaVersion: 1,
      savedAt: 1,
      actors: [
        {
          label: "陆辰",
          color: "#38bdf8",
          position: [1, 0, 2],
          yawDeg: 15,
          scale: [1, 1, 1],
          pose: "standing",
          actionPlaying: true,
        },
      ],
      props: [
        {
          label: "手电筒",
          color: "#ffd34d",
          position: [2, 0.5, 3],
          yawDeg: 30,
          scale: [1, 1, 1],
          shapeHint: "box",
        },
      ],
      stagings: [
        {
          label: "门口光",
          color: "#4587ff",
          position: [0, 0, 4],
          yawDeg: 0,
          scale: [2, 1, 1],
          shapeHint: "generic_large",
        },
      ],
      camera: { azim: 12, elev: -4, distance: 6, focalPoint: [0, 1, 0] },
    });

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={freezoneManifest}
        viewerPurpose="freezone"
        onCaptureCanvasNode={onCaptureCanvasNode}
      />,
    );

    await user.click(screen.getByRole("button", { name: "输出到画布节点" }));

    await waitFor(() => {
      expect(onCaptureCanvasNode).toHaveBeenCalledTimes(1);
    });
    const [combinedBlob, meta] = onCaptureCanvasNode.mock.calls[0];
    expect(combinedBlob).toBeInstanceOf(Blob);
    expect(meta.captureBundle?.combined).toBe(combinedBlob);
    expect(meta.captureBundle?.env_only).toBeInstanceOf(Blob);
    expect(meta.captureBundle?.frame_meta).toMatchObject({
      schema_version: "director_frame_meta_v1",
      source: {
        source_type: "sog",
      },
      layer: {
        actors: [expect.objectContaining({ pose: "standing", action_playing: true })],
        props: [expect.objectContaining({ label: "手电筒" })],
        stagings: [expect.objectContaining({ shape_hint: "generic_large" })],
      },
    });
    const frameMeta = meta.captureBundle?.frame_meta;
    expect(frameMeta?.layer.actors[0]).not.toHaveProperty("shape_hint");
    expect(frameMeta?.layer.actors[0].placement).toMatchObject({ yaw_deg: 15 });
    expect(frameMeta?.layer.props[0]).not.toHaveProperty("pose");
    expect(frameMeta?.layer.props[0]).not.toHaveProperty("action_playing");
    expect(frameMeta?.layer.props[0]).not.toHaveProperty("shapeHint");
    expect(frameMeta?.layer.props[0].placement).toMatchObject({ yaw_deg: 30 });
    const heroProp = frameMeta?.props?.find(
      (item: DirectorFrameMetaProp) => item.type === "prop_hero",
    );
    expect(heroProp).toMatchObject({
      type: "prop_hero",
      category: "hero",
      semantic_label: "手电筒",
    });
    expect(heroProp).not.toHaveProperty("shape_hint");
    expect(frameMeta?.layer.stagings[0]).not.toHaveProperty("pose");
    expect(frameMeta?.layer.stagings[0]).not.toHaveProperty("action_playing");
    expect(frameMeta?.layer.stagings[0]).not.toHaveProperty("shapeHint");
    expect(frameMeta?.layer.stagings[0]).toMatchObject({
      name: "门口光",
      label: "门口光",
      marker_color: "#4587ff",
      semantic_label: "门口光",
    });
    expect(frameMeta?.layer.stagings[0].placement).toMatchObject({ yaw_deg: 0 });
    expect(frameMeta?.stagings?.[0]).toMatchObject({
      name: "门口光",
      label: "门口光",
      type: "prop_staging",
      category: "staging",
      marker_color: "#4587ff",
      semantic_label: "门口光",
    });
    expect(frameMeta?.props?.some((item: DirectorFrameMetaProp) => (
      item.type === "prop_staging"
        && item.semantic_label === "门口光"
        && item.marker_color === "#4587ff"
    ))).toBe(true);
  });

  it("captures only env_only for selected background without writing control-frame bundle", async () => {
    const user = userEvent.setup();
    const onCaptureSelectedBackground = vi.fn();

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
        viewerPurpose="beat"
        onCaptureSelectedBackground={onCaptureSelectedBackground}
      />,
    );

    await user.click(screen.getByRole("button", { name: "用纯背景作背景" }));

    await waitFor(() => {
      expect(onCaptureSelectedBackground).toHaveBeenCalledTimes(1);
    });
    expect(viewerMock.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ renderMode: "env_only", frameAspect: "16:9" }));
    expect(viewerMock.captureScreenshot).not.toHaveBeenCalledWith(expect.objectContaining({ renderMode: "combined", frameAspect: "16:9" }));
    expect(saveBeatDirectorControlFrame).not.toHaveBeenCalled();
    const [envOnlyBlob, meta] = onCaptureSelectedBackground.mock.calls[0];
    expect(envOnlyBlob).toBeInstanceOf(Blob);
    expect(meta.kind).toBe("env_only");
    expect(meta.controlFrameBundle).toBeUndefined();
    expect(meta.captureBundle).toBeUndefined();
  });

  it("preserves pano_view placement in canvas frame_meta", async () => {
    const user = userEvent.setup();
    const onCaptureCanvasNode = vi.fn();
    const freezoneManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      blockings_dir_fs: undefined,
      control_frames_dir_fs: undefined,
      slate_beat: undefined,
      allowed_destinations: ["view", "download", "canvas_screenshot_node"],
    };
    viewerMock.exportSceneSnapshot.mockReturnValueOnce({
      schemaVersion: 1,
      savedAt: 1,
      actors: [
        {
          label: "陆辰",
          color: "#38bdf8",
          position: [0, 0, 0],
          yawDeg: 0,
          placement: { space: "pano_view", yawDeg: 30, pitchDeg: -5, distance: 6 },
          scale: [1, 1, 1],
          pose: "standing",
        },
      ],
      props: [],
      stagings: [],
      camera: { azim: 12, elev: -4, distance: 6, focalPoint: [0, 1, 0] },
    });

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={freezoneManifest}
        viewerPurpose="freezone"
        onCaptureCanvasNode={onCaptureCanvasNode}
      />,
    );

    await user.click(screen.getByRole("button", { name: "输出到画布节点" }));

    await waitFor(() => {
      expect(onCaptureCanvasNode).toHaveBeenCalledTimes(1);
    });
    const meta = onCaptureCanvasNode.mock.calls[0][1];
    expect(meta.captureBundle?.frame_meta.layer.actors[0].placement).toEqual({
      space: "pano_view",
      yaw_deg: 30,
      pitch_deg: -5,
      distance: 6,
    });
  });

  it("uses pano360 image sources as 3D stage environment spheres with placement enabled", async () => {
    const user = userEvent.setup();
    const onCaptureCanvasNode = vi.fn();
    const panoManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      allowed_destinations: ["view", "download", "canvas_screenshot_node"],
      source_options: [
        { kind: "master", label: "master", source_type: "sog", ply_url: "/static/demo/master.sog" },
        {
          kind: "pano",
          label: "director pano",
          source_type: "pano360",
          url: "/static/demo/pano_360.png",
          slot_kind: "scene_director_pano_360",
        },
      ],
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={panoManifest}
        viewerPurpose="freezone"
        onCaptureCanvasNode={onCaptureCanvasNode}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText("世界来源"),
      screen.getByRole("option", { name: "director pano · 360图" }),
    );

    expect(screen.queryByTestId("pano-capture-surface")).not.toBeInTheDocument();
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute(
      "data-pano-url",
      "/static/demo/pano_360.png",
    );
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute("data-splat-url", "");
    expect(screen.getByRole("button", { name: /^人物/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "输出到画布节点" }));

    await waitFor(() => {
      expect(onCaptureCanvasNode).toHaveBeenCalledTimes(1);
    });
    expect(viewerMock.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ renderMode: "combined", frameAspect: "16:9" }));
    expect(viewerMock.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ renderMode: "env_only", frameAspect: "16:9" }));
    const [panoBlob, panoMeta] = onCaptureCanvasNode.mock.calls[0];
    expect(panoBlob).toBeInstanceOf(Blob);
    expect(panoMeta).toMatchObject({
      kind: "combined",
      source: {
        source_type: "pano360",
        pano_url: "/static/demo/pano_360.png",
        source_kind: "pano",
      },
      snapshot: {
        camera: {
          focalPoint: [0, 0, 0],
        },
      },
    });
    expect(panoMeta.captureBundle?.combined).toBe(panoBlob);
    expect(panoMeta.captureBundle?.env_only).toBeInstanceOf(Blob);
    expect(panoMeta.captureBundle?.frame_meta).toMatchObject({
      schema_version: "director_frame_meta_v1",
      source: {
        source_type: "pano360",
      },
      camera: {
        mode: "pano",
      },
    });
  });

  it("shows full advanced world calibration controls for pano360 sources", async () => {
    const user = userEvent.setup();
    const panoManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      source_options: [
        { kind: "master", label: "master", source_type: "sog", ply_url: "/static/demo/master.sog" },
        {
          kind: "pano",
          label: "director pano",
          source_type: "pano360",
          url: "/static/demo/pano_360.png",
          slot_kind: "scene_director_pano_360",
        },
      ],
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={panoManifest}
        viewerPurpose="freezone"
      />,
    );

    await user.selectOptions(
      screen.getByLabelText("世界来源"),
      screen.getByRole("option", { name: "director pano · 360图" }),
    );
    await user.click(screen.getByRole("button", { name: /高级校准/ }));

    const xOffset = screen.getByRole("slider", { name: /左右/ });
    const yOffset = screen.getByRole("slider", { name: /高度/ });
    const zOffset = screen.getByRole("slider", { name: /前后/ });
    const scale = screen.getByRole("slider", { name: /世界比例/ });

    expect(xOffset).toHaveAttribute("min", "-240");
    expect(xOffset).toHaveAttribute("max", "240");
    expect(yOffset).toHaveAttribute("min", "-240");
    expect(yOffset).toHaveAttribute("max", "240");
    expect(zOffset).toHaveAttribute("min", "-240");
    expect(zOffset).toHaveAttribute("max", "240");
    expect(scale).toHaveAttribute("min", "0.1");
    expect(scale).toHaveAttribute("max", "8");
  });

  it("restores saved pano camera after the pano environment source is ready", async () => {
    const savedScene = {
      schemaVersion: 1 as const,
      savedAt: 7,
      actors: [],
      props: [],
      stagings: [],
      camera: { azim: 123, elev: -8, distance: 0.2, focalPoint: [0, 0.5, 0] as [number, number, number] },
    };
    const panoManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      source_options: [
        {
          kind: "pano",
          label: "director pano",
          source_type: "pano360",
          url: "/static/demo/pano_360.png",
          slot_kind: "scene_director_pano_360",
        },
      ],
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={panoManifest}
        initialScene={savedScene}
      />,
    );

    await waitFor(() => {
      expect(viewerMock.loadSceneSnapshot).toHaveBeenCalledWith(savedScene);
    });
  });

  it("restores manifest saved scene when the real manifest arrives after the blank shell", async () => {
    const savedScene = {
      schemaVersion: 1 as const,
      savedAt: 9,
      actors: [
        {
          id: "actor-1",
          label: "杜晨",
          color: "#00aaff",
          position: [0, 0, 0] as [number, number, number],
          yawDeg: 0,
          scale: [1, 1, 1] as [number, number, number],
        },
      ],
      props: [],
      stagings: [],
      camera: { azim: 10, elev: -4, distance: 1.2, focalPoint: [0, 0, 0] as [number, number, number] },
      world: { activeSourceId: "legacy:master:sog:/static/demo/master.sog" },
    };
    const realManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      active_source_id: "legacy:master:sog:/static/demo/master.sog",
      source_options: [
        {
          kind: "master",
          label: "master",
          source_type: "sog",
          ply_url: "/static/demo/master.sog",
        },
      ],
      scene: savedScene,
      scenes_by_source_id: {
        "legacy:master:sog:/static/demo/master.sog": savedScene,
      },
    };

    const { rerender } = render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={null}
      />,
    );

    viewerMock.loadSceneSnapshot.mockClear();

    rerender(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={realManifest}
        initialScene={realManifest.scene}
        initialScenesBySourceId={realManifest.scenes_by_source_id}
      />,
    );

    await waitFor(() => {
      expect(viewerMock.loadSceneSnapshot).toHaveBeenCalledWith(savedScene);
    });
  });

  it("restores manifest saved scene when source urls include backend version tokens", async () => {
    const savedScene = {
      schemaVersion: 1 as const,
      savedAt: 9,
      actors: [
        {
          id: "actor-1",
          label: "杜晨",
          color: "#00aaff",
          position: [0, 0, 0] as [number, number, number],
          yawDeg: 0,
          scale: [1, 1, 1] as [number, number, number],
        },
      ],
      props: [],
      stagings: [],
      camera: { azim: 10, elev: -4, distance: 1.2, focalPoint: [0, 0, 0] as [number, number, number] },
      world: { activeSourceId: "legacy:master:sog:/static/demo/master.sog" },
    };
    const realManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      active_source_id: "legacy:master:sog:/static/demo/master.sog",
      source_options: [
        {
          kind: "master",
          label: "master",
          source_type: "sog",
          ply_url: "/static/demo/master.sog?v=1782367956957592481",
        },
      ],
      scene: savedScene,
      scenes_by_source_id: {
        "legacy:master:sog:/static/demo/master.sog": savedScene,
      },
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={realManifest}
        initialScene={realManifest.scene}
        initialScenesBySourceId={realManifest.scenes_by_source_id}
      />,
    );

    await waitFor(() => {
      expect(viewerMock.loadSceneSnapshot).toHaveBeenCalledWith(savedScene);
    });
  });

  it("passes the active source id when saving the Director World scene", async () => {
    const user = userEvent.setup();
    const onSaveScene = vi.fn();
    const panoManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      sources: [
        {
          id: "master_sog",
          source_kind: "master",
          label: "Master SOG",
          source_type: "sog",
          ply_url: "/static/demo/master.sog",
        },
        {
          id: "director_pano",
          source_kind: "pano",
          label: "Director Pano",
          source_type: "pano360",
          pano_url: "/static/demo/director_pano.png",
          slot_kind: "scene_director_pano_360",
        },
      ],
      active_source_id: "director_pano",
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={panoManifest}
        onSaveScene={onSaveScene}
      />,
    );

    await user.click(screen.getByRole("button", { name: "保存导演世界" }));

    expect(onSaveScene).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        world: expect.objectContaining({ activeSourceId: "director_pano" }),
      }),
      "director_pano",
    );
  });

  it("registers an imperative save handler for open freezone Director World commits", async () => {
    const onSaveScene = vi.fn();
    let saveHandler: (() => Promise<void>) | null = null;
    const freezoneManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      sources: [
        {
          id: "custom_sog",
          source_kind: "custom",
          label: "Custom SOG",
          source_type: "sog",
          ply_url: "/static/demo/custom.sog",
        },
      ],
      active_source_id: "custom_sog",
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={freezoneManifest}
        onSaveScene={onSaveScene}
        registerSaveSceneHandler={(handler) => {
          saveHandler = handler;
        }}
      />,
    );

    await waitFor(() => {
      expect(saveHandler).toEqual(expect.any(Function));
    });

    await act(async () => {
      await saveHandler?.();
    });

    expect(onSaveScene).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        world: expect.objectContaining({ activeSourceId: "custom_sog" }),
      }),
      "custom_sog",
    );

    cleanup();
    expect(saveHandler).toBeNull();
  });

  it("keeps a saved scene pano source active when the backend scene manifest also has a master source", async () => {
    const sceneManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      scene_id: "Hall",
      display_name: "Hall",
      beat_context: undefined,
      source: {
        source_type: "sog",
        source_kind: "master",
        ply_url: "/static/demo/master.sog",
      },
      source_options: [
        {
          kind: "master",
          label: "master",
          source_type: "sog",
          ply_url: "/static/demo/master.sog",
          current: true,
        },
        {
          kind: "pano",
          label: "360 图",
          source_type: "pano360",
          pano_url: "/static/demo/hall_360.png",
          slot_kind: "scene_director_pano_360",
        },
      ],
      active_source_id: "scene-pano:Hall",
      scene: {
        schemaVersion: 1,
        savedAt: 1,
        world: { activeSourceId: "scene-pano:Hall" },
        actors: [],
        props: [],
        stagings: [],
      },
      scenes_by_source_id: {
        "scene-pano:Hall": {
          schemaVersion: 1,
          savedAt: 1,
          world: { activeSourceId: "scene-pano:Hall" },
          actors: [],
          props: [],
          stagings: [],
        },
      },
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={sceneManifest}
        onSaveScene={vi.fn()}
      />,
    );

    expect(screen.getByTestId("stage-canvas")).toHaveAttribute(
      "data-pano-url",
      "/static/demo/hall_360.png",
    );
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute("data-splat-url", "");
  });

  it("creates staging props through the project AI staging API", async () => {
    const user = userEvent.setup();

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: /AI 占位/ }));
    expect(screen.getByRole("button", { name: "AI 占位" })).toBeDisabled();
    await user.type(screen.getByLabelText("占位名"), "马");
    await user.click(screen.getByRole("button", { name: "AI 占位" }));

    await waitFor(() => {
      expect(generateAiStagingProp).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          scene_id: "地下室",
          user_hint: "马",
          renderer_backend: "playcanvas_3gs",
        }),
      );
    });
    expect(viewerMock.placeMarker).toHaveBeenCalledWith("staging", {
      color: "#B71C1C",
      label: "可骑的马",
      scale: [1.4, 1.25, 2.2],
      position: [1, 0, 2],
      shapeHint: "quadruped_mount",
    });
  });

  it("lets scene props and staging share a selectable prop palette", async () => {
    const user = userEvent.setup();
    const sceneManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      blockings_dir_fs: undefined,
      control_frames_dir_fs: undefined,
      slate_beat: undefined,
      palette: {
        ...manifest.palette,
        actors: [],
        props: [],
        anonymous_prop_colors: ["#B71C1C", "#6D4C41"],
      },
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={sceneManifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: /道具/ }));
    await user.click(screen.getByRole("button", { name: "#6D4C41" }));
    expect(screen.queryByLabelText("viewer.threeD.propName")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "把人物放到准星" }));
    expect(viewerMock.placeMarker).toHaveBeenLastCalledWith("prop", {
      color: "#6D4C41",
      label: "匿名道具 1",
    });

    await user.click(screen.getByRole("button", { name: /AI 占位/ }));
    await user.click(screen.getByRole("button", { name: "#B71C1C" }));
    expect(screen.getByRole("button", { name: "本地占位" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "把人物放到准星" })).toBeDisabled();
    await user.type(screen.getByLabelText("占位名"), "马");
    await user.click(screen.getByRole("button", { name: "本地占位" }));
    expect(viewerMock.placeMarker).toHaveBeenLastCalledWith("staging", {
      color: "#B71C1C",
      label: "马",
    });
  });

  it("renames the selected staging placeholder", async () => {
    const user = userEvent.setup();
    viewerMock.onSelectionChange.mockImplementationOnce((listener) => {
      listener({
        kind: "staging",
        index: 0,
        label: "旧占位",
        position: [1, 2, 3],
        pose: null,
        actionPlaying: null,
        shapeHint: "generic_large",
      });
      return () => undefined;
    });

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.clear(screen.getByLabelText("选中占位名"));
    await user.type(screen.getByLabelText("选中占位名"), "新占位");

    expect(viewerMock.setSelectedLabel).toHaveBeenLastCalledWith("新占位");
  });

  it("passes the active source id when clearing the saved Director World scene", async () => {
    const user = userEvent.setup();
    const onClearScene = vi.fn();
    const savedPanoScene = {
      schemaVersion: 1 as const,
      savedAt: 9,
      actors: [],
      props: [],
      stagings: [],
      world: { activeSourceId: "director_pano" },
      camera: { azim: 88, elev: -6, distance: 0.4, focalPoint: [0, 0.5, 0] as [number, number, number] },
    };
    const panoManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      sources: [
        {
          id: "director_pano",
          source_kind: "pano",
          label: "Director Pano",
          source_type: "pano360",
          pano_url: "/static/demo/director_pano.png",
          slot_kind: "scene_director_pano_360",
        },
      ],
      active_source_id: "director_pano",
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={panoManifest}
        initialScenesBySourceId={{ director_pano: savedPanoScene }}
        onClearScene={onClearScene}
      />,
    );

    await user.click(screen.getByRole("button", { name: "清空保存" }));

    expect(viewerMock.clearMarkers).toHaveBeenCalled();
    expect(onClearScene).toHaveBeenCalledWith("director_pano");
  });

  it("restores a saved source snapshot when switching away and back", async () => {
    const user = userEvent.setup();
    const savedPanoScene = {
      schemaVersion: 1 as const,
      savedAt: 9,
      actors: [],
      props: [],
      stagings: [],
      world: { activeSourceId: "director_pano" },
      camera: { azim: 88, elev: -6, distance: 0.4, focalPoint: [0, 0.5, 0] as [number, number, number] },
    };
    const worldSourceManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      sources: [
        {
          id: "master_sog",
          source_kind: "master",
          label: "Master SOG",
          source_type: "sog",
          ply_url: "/static/demo/master.sog",
        },
        {
          id: "director_pano",
          source_kind: "pano",
          label: "Director Pano",
          source_type: "pano360",
          pano_url: "/static/demo/director_pano.png",
          slot_kind: "scene_director_pano_360",
        },
      ],
      active_source_id: "director_pano",
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={worldSourceManifest}
        initialScenesBySourceId={{ director_pano: savedPanoScene }}
      />,
    );

    await waitFor(() => {
      expect(viewerMock.loadSceneSnapshot).toHaveBeenCalledWith(savedPanoScene);
    });
    viewerMock.loadSceneSnapshot.mockClear();

    await user.selectOptions(
      screen.getByLabelText("世界来源"),
      screen.getByRole("option", { name: "Master SOG" }),
    );
    await user.selectOptions(
      screen.getByLabelText("世界来源"),
      screen.getByRole("option", { name: "Director Pano · 360图" }),
    );

    await waitFor(() => {
      expect(viewerMock.loadSceneSnapshot).toHaveBeenCalledWith(savedPanoScene);
    });
  });

  it("captures pano360 env_only for selected background without writing bundle", async () => {
    const user = userEvent.setup();
    const onCaptureSelectedBackground = vi.fn();
    const panoManifest: DirectorStageManifest = {
      ...manifest,
      allowed_destinations: ["view", "download", "beat_selected_background"],
      source_options: [
        {
          kind: "pano",
          label: "director pano",
          source_type: "pano360",
          url: "/static/demo/pano_360.png",
          slot_kind: "scene_director_pano_360",
        },
      ],
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={panoManifest}
        viewerPurpose="beat"
        onCaptureSelectedBackground={onCaptureSelectedBackground}
      />,
    );

    await user.click(screen.getByRole("button", { name: "用纯背景作背景" }));

    await waitFor(() => {
      expect(onCaptureSelectedBackground).toHaveBeenCalledTimes(1);
    });
    expect(viewerMock.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ renderMode: "env_only", frameAspect: "16:9" }));
    expect(saveBeatDirectorControlFrame).not.toHaveBeenCalled();
    const [envOnlyBlob, meta] = onCaptureSelectedBackground.mock.calls[0];
    expect(meta.kind).toBe("env_only");
    expect(meta.source.source_type).toBe("pano360");
    expect(envOnlyBlob).toBeInstanceOf(Blob);
    expect(meta.controlFrameBundle).toBeUndefined();
    expect(meta.captureBundle).toBeUndefined();
  });

  it("persists the active pano source id when beat selected-background capture writes overlay only", async () => {
    const user = userEvent.setup();
    const onCaptureSelectedBackground = vi.fn();
    const panoManifest: DirectorStageManifest = {
      ...manifest,
      sources: [
        {
          id: "director_pano",
          source_kind: "pano",
          label: "Director Pano",
          source_type: "pano360",
          pano_url: "/static/demo/director_pano.png",
          slot_kind: "scene_director_pano_360",
        },
      ],
      active_source_id: "director_pano",
      allowed_destinations: ["view", "download", "beat_selected_background"],
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={panoManifest}
        viewerPurpose="beat"
        onCaptureSelectedBackground={onCaptureSelectedBackground}
      />,
    );

    await user.click(screen.getByRole("button", { name: "用纯背景作背景" }));

    await waitFor(() => {
      expect(onCaptureSelectedBackground).toHaveBeenCalledTimes(1);
    });
    const overlaySaveCalls = vi.mocked(saveBeatDirectorStageOverlay).mock.calls;
    const overlayPayload = overlaySaveCalls[overlaySaveCalls.length - 1]?.[3];
    expect(overlayPayload?.snapshot).toMatchObject({
      world: { activeSourceId: "director_pano" },
    });
    expect(saveBeatDirectorControlFrame).not.toHaveBeenCalled();
    expect(onCaptureSelectedBackground.mock.calls[0][1].snapshot).toMatchObject({
      world: { activeSourceId: "director_pano" },
    });
  });

  it("allows contextual combined output when the caller provides a canvas capture handler", async () => {
    const user = userEvent.setup();
    const onCaptureCanvasNode = vi.fn();
    const contextualManifest: DirectorStageManifest = {
      ...manifest,
      allowed_destinations: ["view", "download", "beat_selected_background"],
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={contextualManifest}
        viewerPurpose="beat"
        onCaptureCanvasNode={onCaptureCanvasNode}
      />,
    );

    await user.click(screen.getByRole("button", { name: "输出到画布节点" }));

    await waitFor(() => {
      expect(onCaptureCanvasNode).toHaveBeenCalledTimes(1);
    });
  });

  it("uses director world sources before legacy source options", async () => {
    const user = userEvent.setup();
    const worldSourceManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      source: {
        ply_url: "/static/demo/world.sog",
        collision_glb_url: "/static/demo/fallback-collision.glb",
        source_kind: "master",
      },
      source_options: [
        {
          kind: "reverse",
          label: "Legacy Reverse",
          source_type: "sog",
          ply_url: "/static/demo/reverse.sog",
        },
      ],
      sources: [
        {
          id: "master_sog",
          source_kind: "master",
          label: "Master SOG",
          source_type: "sog",
          ply_url: "/static/demo/master.sog",
          collision_glb_url: "/static/demo/master-collision.glb",
        },
        {
          id: "director_pano",
          source_kind: "pano",
          label: "Director Pano",
          source_type: "pano360",
          pano_url: "/static/demo/director_pano.png",
          slot_kind: "scene_director_pano_360",
        },
        {
          id: "no_collision_sog",
          source_kind: "custom",
          label: "No Collision SOG",
          source_type: "sog",
          ply_url: "/static/demo/no-collision.sog",
        },
      ],
      active_source_id: "director_pano",
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={worldSourceManifest}
      />,
    );

    expect(screen.getByRole("option", { name: "Director Pano · 360图" })).toHaveProperty(
      "selected",
      true,
    );
    expect(screen.queryByRole("option", { name: "Legacy Reverse" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("pano-capture-surface")).not.toBeInTheDocument();
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute(
      "data-pano-url",
      "/static/demo/director_pano.png",
    );
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute("data-splat-url", "");

    await user.selectOptions(
      screen.getByLabelText("世界来源"),
      screen.getByRole("option", { name: "Master SOG" }),
    );

    expect(screen.getByTestId("stage-canvas")).toHaveAttribute(
      "data-splat-url",
      "/static/demo/master.sog",
    );
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute(
      "data-collision-url",
      "/static/demo/master-collision.glb",
    );

    await user.selectOptions(
      screen.getByLabelText("世界来源"),
      screen.getByRole("option", { name: "No Collision SOG" }),
    );

    expect(screen.getByTestId("stage-canvas")).toHaveAttribute(
      "data-splat-url",
      "/static/demo/no-collision.sog",
    );
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute("data-collision-url", "");
  });

  it("captures the active combined frame and clean env plate for director export", async () => {
    const user = userEvent.setup();
    const onCaptureCanvasNode = vi.fn();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
        onCaptureCanvasNode={onCaptureCanvasNode}
      />,
    );

    await user.click(screen.getByRole("button", { name: "输出到画布节点" }));

    expect(viewerMock.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ renderMode: "combined", frameAspect: "16:9" }));
    expect(viewerMock.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ renderMode: "env_only", frameAspect: "16:9" }));
    expect(viewerMock.captureScreenshot).not.toHaveBeenCalledWith(expect.objectContaining({ renderMode: "actor_overlay_black" }));
    expect(viewerMock.captureScreenshot).not.toHaveBeenCalledWith(expect.objectContaining({ renderMode: "actor_mask" }));
  });

  it("allows beat workbench director world entries to write the control-frame bundle", async () => {
    const user = userEvent.setup();
    const onSubmitDirectorCombined = vi.fn();
    const onCaptureCanvasNode = vi.fn();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
        viewerPurpose="beat"
        autoCommitDirectorCombined
        onSubmitDirectorCombined={onSubmitDirectorCombined}
        onCaptureCanvasNode={onCaptureCanvasNode}
      />,
    );

    expect(screen.getByRole("button", { name: "提交当前取景为导演合成图" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "输出到画布节点" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "用纯背景作背景" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交当前取景为背景" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "写入镜头控制图" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "快捷操作" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "写入" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "提交当前取景为导演合成图" }));

    await waitFor(() => {
      expect(saveBeatDirectorControlFrame).toHaveBeenCalledTimes(1);
    });
    expect(onSubmitDirectorCombined).toHaveBeenCalledTimes(1);
    expect(onCaptureCanvasNode).not.toHaveBeenCalled();
    expect(viewerMock.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ renderMode: "combined", frameAspect: "16:9" }));
    expect(viewerMock.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ renderMode: "env_only", frameAspect: "16:9" }));
  });

  it("keeps canvas output separate from local director-combined submission", async () => {
    const user = userEvent.setup();
    const onSubmitDirectorCombined = vi.fn();
    const onCaptureCanvasNode = vi.fn();
    const localBeatManifest: DirectorStageManifest = {
      ...manifest,
      allowed_destinations: ["view", "download", "beat_selected_background", "canvas_screenshot_node"],
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={localBeatManifest}
        viewerPurpose="beat"
        onSubmitDirectorCombined={onSubmitDirectorCombined}
        onCaptureCanvasNode={onCaptureCanvasNode}
      />,
    );

    expect(screen.getByRole("button", { name: "输出当前取景为导演合成图" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "输出当前取景为导演合成图" }));

    await waitFor(() => {
      expect(onSubmitDirectorCombined).toHaveBeenCalledTimes(1);
    });
    expect(saveBeatDirectorControlFrame).not.toHaveBeenCalled();
    expect(onCaptureCanvasNode).not.toHaveBeenCalled();
    expect(onSubmitDirectorCombined.mock.calls[0][1].captureBundle).toBeDefined();

    await user.click(screen.getByRole("button", { name: "输出到画布节点" }));

    await waitFor(() => {
      expect(onCaptureCanvasNode).toHaveBeenCalledTimes(1);
    });
    expect(onSubmitDirectorCombined).toHaveBeenCalledTimes(1);
  });

  it("routes the quick actions write action through the same director-combined callback", async () => {
    const user = userEvent.setup();
    const onSubmitDirectorCombined = vi.fn();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
        viewerPurpose="beat"
        autoCommitDirectorCombined
        onSubmitDirectorCombined={onSubmitDirectorCombined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "快捷操作" }));
    await user.click(screen.getByRole("button", { name: "写入" }));

    await waitFor(() => {
      expect(saveBeatDirectorControlFrame).toHaveBeenCalledTimes(1);
    });
    expect(onSubmitDirectorCombined).toHaveBeenCalledTimes(1);
    expect(onSubmitDirectorCombined.mock.calls[0][1].controlFrameBundle).toMatchObject({
      rel_paths: {
        combined: "director_control_frames/ep001/beat_03/combined.png",
        env_only: "director_control_frames/ep001/beat_03/env_only.png",
        frame_meta: "director_control_frames/ep001/beat_03/frame_meta.json",
      },
    });
  });

  it("keeps shape hints on prop and staging snapshots while pose stays actor-only", async () => {
    const user = userEvent.setup();
    viewerMock.exportSceneSnapshot.mockReturnValueOnce({
      schemaVersion: 1,
      savedAt: 1,
      actors: [
        {
          label: "陆辰",
          color: "#38bdf8",
          position: [0, 0, 0],
          yawDeg: 0,
          scale: [1, 1, 1],
          pose: "standing",
          actionPlaying: true,
        },
      ],
      props: [
        {
          label: "马",
          color: "#ffd34d",
          position: [1, 0.6, 0],
          yawDeg: 10,
          scale: [1.25, 1.25, 1.9],
          shapeHint: "quadruped_mount",
        },
      ],
      stagings: [
        {
          label: "纸箱堆",
          color: "#4587ff",
          position: [2, 0.3, 0],
          yawDeg: 0,
          scale: [2, 1, 1],
          shapeHint: "pile",
        },
      ],
      camera: { azim: 0, elev: 0, distance: 1, focalPoint: [0, 0, 0] },
    });

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "保存此镜头导演状态" }));

    await waitFor(() => {
      expect(saveBeatDirectorStageOverlay).toHaveBeenCalled();
    });
    const overlaySaveCalls = vi.mocked(saveBeatDirectorStageOverlay).mock.calls;
    const payload = overlaySaveCalls[overlaySaveCalls.length - 1]?.[3] as {
      snapshot?: {
        actors?: Array<{ pose?: string; shapeHint?: string }>;
        props?: Array<{ pose?: string; shapeHint?: string }>;
        stagings?: Array<{ pose?: string; shapeHint?: string }>;
      };
      actors?: Array<{ state?: string; shape_hint?: string }>;
      props?: Array<{ state?: string; shape_hint?: string }>;
      stagings?: Array<{ state?: string; shape_hint?: string }>;
    };

    expect(payload.snapshot?.actors?.[0]).toMatchObject({ pose: "standing" });
    expect(payload.snapshot?.props?.[0]).toMatchObject({ shapeHint: "quadruped_mount" });
    expect(payload.snapshot?.stagings?.[0]).toMatchObject({ shapeHint: "pile" });
    expect(payload.actors?.[0]).toMatchObject({ state: "standing" });
    expect(payload.props?.[0]).not.toHaveProperty("shape_hint");
    expect(payload.stagings?.[0]).toMatchObject({ shape_hint: "pile" });
    expect(payload.props?.[0]?.state).toBeUndefined();
    expect(payload.stagings?.[0]?.state).toBeUndefined();
  });

  it("saves active source metadata with the current beat overlay", async () => {
    const user = userEvent.setup();
    const panoManifest: DirectorStageManifest = {
      ...manifest,
      sources: [
        {
          id: "master_sog",
          source_type: "sog",
          source_kind: "master",
          label: "master",
          ply_url: "/static/demo/world.sog",
        },
        {
          id: "director_pano",
          source_type: "pano360",
          source_kind: "pano",
          label: "360",
          pano_url: "/static/demo/director_pano.png",
          pano_fs: "/tmp/demo/director_pano.png",
          slot_kind: "scene_director_pano_360",
        },
      ],
      active_source_id: "director_pano",
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={panoManifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "保存此镜头导演状态" }));

    await waitFor(() => {
      expect(saveBeatDirectorStageOverlay).toHaveBeenCalled();
    });
    const overlaySaveCalls = vi.mocked(saveBeatDirectorStageOverlay).mock.calls;
    const payload = overlaySaveCalls[overlaySaveCalls.length - 1]?.[3] as {
      source?: Record<string, unknown>;
      frame_meta?: Record<string, unknown>;
    };

    expect(payload.source).toMatchObject({
      source_id: "director_pano",
      source_type: "pano360",
      source_kind: "pano",
      pano_url: "/static/demo/director_pano.png",
      pano_fs: "/tmp/demo/director_pano.png",
      slot_kind: "scene_director_pano_360",
    });
    expect(payload.frame_meta).toMatchObject({
      source: payload.source,
      camera: {
        mode: "pano",
        frame_aspect: "16:9",
      },
    });
  });

  it("saves the user-selected source when the beat source picker changes", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={{
          ...manifest,
          sources: [
            {
              id: "master_sog",
              source_type: "sog",
              source_kind: "master",
              label: "Master SOG",
              ply_url: "/static/demo/master.sog",
            },
            {
              id: "director_pano",
              source_type: "pano360",
              source_kind: "pano",
              label: "Director Pano",
              pano_url: "/static/demo/director_pano.png",
            },
          ],
          active_source_id: "master_sog",
        }}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText("世界来源"),
      screen.getByRole("option", { name: "Director Pano · 360图" }),
    );
    await user.click(screen.getByRole("button", { name: "保存此镜头导演状态" }));

    await waitFor(() => {
      expect(saveBeatDirectorStageOverlay).toHaveBeenCalled();
    });
    const overlaySaveCalls = vi.mocked(saveBeatDirectorStageOverlay).mock.calls;
    const payload = overlaySaveCalls[overlaySaveCalls.length - 1]?.[3];
    expect(payload).toMatchObject({
      source: {
        source_id: "director_pano",
        source_type: "pano360",
      },
      snapshot: {
        world: { activeSourceId: "director_pano" },
      },
      frame_meta: {
        source: {
          source_id: "director_pano",
          source_type: "pano360",
        },
      },
    });
  });

  it("edits shape hint only for selected staging markers", async () => {
    const user = userEvent.setup();
    viewerMock.onSelectionChange.mockImplementationOnce((listener) => {
      listener({
        kind: "staging",
        index: 0,
        label: "马",
        position: [1, 0.6, 0],
        pose: null,
        actionPlaying: null,
        shapeHint: "box",
      });
      return () => undefined;
    });

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.selectOptions(screen.getByLabelText("占位形状"), "quadruped_mount");

    expect(viewerMock.setSelectedShapeHint).toHaveBeenCalledWith("quadruped_mount");
    expect(viewerMock.setSelectedPose).not.toHaveBeenCalledWith("quadruped_mount");
  });

  it("keeps the left panel focused on compact selected-object controls", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    expect(screen.queryByRole("button", { name: "俯看全场" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "看向人物" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("人物姿势"), "running");
    expect(viewerMock.setSelectedPose).toHaveBeenCalledWith("running");

    await user.click(screen.getByRole("button", { name: "删除选中" }));
    expect(viewerMock.deleteSelected).toHaveBeenCalled();
  });

  it("uses the F shortcut only for moving the selection to the crosshair", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    await user.keyboard("f");

    expect(viewerMock.moveSelectedToCrosshair).toHaveBeenCalled();
  });

  it("uses keyboard arrow keys to nudge the selected director object", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    await user.keyboard("{ArrowUp}{ArrowDown}{ArrowLeft}{ArrowRight}");

    expect(viewerMock.nudgeSelected).toHaveBeenNthCalledWith(1, 0, 0, -0.1);
    expect(viewerMock.nudgeSelected).toHaveBeenNthCalledWith(2, 0, 0, 0.1);
    expect(viewerMock.nudgeSelected).toHaveBeenNthCalledWith(3, -0.1, 0, 0);
    expect(viewerMock.nudgeSelected).toHaveBeenNthCalledWith(4, 0.1, 0, 0);
  });

  it("does not delete the selected director object from an unmodified delete key", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    await user.keyboard("{Delete}");
    await user.keyboard("x");

    expect(viewerMock.deleteSelected).not.toHaveBeenCalled();
  });

  it("uses Shift+Delete to delete the selected director object from the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    await user.keyboard("{Shift>}{Delete}{/Shift}");

    expect(viewerMock.deleteSelected).toHaveBeenCalledTimes(1);
  });

  it("opens a shortcut reference panel from the question-mark shortcut", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    expect(screen.queryByText("导演世界快捷键")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true, bubbles: true }),
      );
    });

    expect(screen.getByText("导演世界快捷键")).toBeInTheDocument();
    expect(screen.getByText("删除选中对象（防误删）")).toBeInTheDocument();
  });

  it("uses P to save the current beat director state", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", code: "KeyP", bubbles: true }),
      );
    });

    await waitFor(() => {
      expect(saveBeatDirectorStageOverlay).toHaveBeenCalled();
    });
  });

  it("uses P to save a freezone Director World scene", async () => {
    const user = userEvent.setup();
    const onSaveScene = vi.fn();
    const freezoneManifest: DirectorStageManifest = {
      ...manifest,
      mode: "scene",
      beat_context: undefined,
      blockings_dir_fs: undefined,
      control_frames_dir_fs: undefined,
      slate_beat: undefined,
      allowed_destinations: ["view", "download", "canvas_screenshot_node"],
    };

    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={freezoneManifest}
        viewerPurpose="freezone"
        onSaveScene={onSaveScene}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", code: "KeyP", bubbles: true }),
      );
    });

    await waitFor(() => {
      expect(onSaveScene).toHaveBeenCalled();
    });
    expect(toast.success).toHaveBeenCalledWith("已保存导演世界场景");
  });

  it("calibrates world rotation through the direction ball", async () => {
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    const ball = screen.getByRole("slider", { name: "方向球" });
    vi.spyOn(ball, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 128,
      bottom: 128,
      width: 128,
      height: 128,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(ball, { clientX: 64, clientY: 64, pointerId: 1 });
    fireEvent.pointerMove(ball, { clientX: 96, clientY: 32, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(ball, { clientX: 96, clientY: 32, pointerId: 1 });

    expect(viewerMock.setSourceTransform).toHaveBeenCalledWith(expect.objectContaining({
      yawDeg: 90,
      pitchDeg: 45,
    }));
  });

  it("continues direction ball dragging after pointer capture when buttons is zero", async () => {
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    const ball = screen.getByRole("slider", { name: "方向球" });
    vi.spyOn(ball, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 128,
      bottom: 128,
      width: 128,
      height: 128,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(ball, { clientX: 64, clientY: 64, pointerId: 11 });
    fireEvent.pointerMove(ball, { clientX: 96, clientY: 32, pointerId: 11, buttons: 0 });
    fireEvent.pointerUp(ball, { clientX: 96, clientY: 32, pointerId: 11 });

    expect(viewerMock.setSourceTransform).toHaveBeenCalledWith(expect.objectContaining({
      yawDeg: 90,
      pitchDeg: 45,
    }));
  });

  it("does not use Shift+U/O for world height calibration anymore", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "U", code: "KeyU", shiftKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "O", code: "KeyO", shiftKey: true, bubbles: true }));
    });

    expect(viewerMock.nudgeWorldYOffset).not.toHaveBeenCalled();
  });

  it("keeps Director World interaction active when the left panel is used", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute("data-active", "true");

    await user.click(screen.getByRole("button", { name: /道具/ }));
    expect(screen.getByTestId("stage-canvas")).toHaveAttribute("data-active", "true");
  });

  it("uses Escape to leave Director World interaction instead of closing the dialog", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={onOpenChange}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
      );
    });

    expect(viewerMock.clearSelection).toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false, expect.anything());
    expect(screen.getByRole("button", { name: "点击进入导演世界" })).toBeInTheDocument();
  });

  it("uses BuilderGPT physical key semantics for F", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "а", code: "KeyF", bubbles: true }),
      );
    });

    expect(viewerMock.moveSelectedToCrosshair).toHaveBeenCalled();
  });

  it("uses H and Tab for the side panel while Director World interaction is active", async () => {
    const user = userEvent.setup();
    render(
      <ThreeDDirectorDialog
        open
        onOpenChange={() => undefined}
        manifest={manifest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "点击进入导演世界" }));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", code: "KeyH", bubbles: true }),
      );
    });
    expect(viewerMock.fitView).not.toHaveBeenCalled();
    expect(screen.queryByTestId("director-world-panel-title")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true }),
      );
    });
    expect(screen.getByTestId("director-world-panel-title")).toBeInTheDocument();
  });
});

cleanup();
