// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SketchCropDialog } from "@/components/episode/beat-workbench/sketch-crop-dialog";
import { useAspectRatioStore } from "@/stores/aspect-ratio-store";

const poseEditorQueryMock = vi.hoisted(() => vi.fn());
const cropSketchMock = vi.hoisted(() => vi.fn());

const SKETCH_CROP_DIALOG_TRANSLATIONS: Record<string, string> = {
  "episode.workbench.sketch.cropTitleWithAspect": "裁剪 {{aspect}}",
  "episode.workbench.sketch.cropDragHandle": "移动裁剪区域",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      varsOrFallback?: Record<string, string | number> | string,
      fallback?: string,
    ) => {
      if (typeof varsOrFallback === "string") {
        return SKETCH_CROP_DIALOG_TRANSLATIONS[key] ?? varsOrFallback;
      }
      const template = SKETCH_CROP_DIALOG_TRANSLATIONS[key] ?? fallback ?? key;
      if (!varsOrFallback) return template;
      return Object.entries(varsOrFallback).reduce(
        (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
        template,
      );
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/queries/sketch-pose-editor", () => ({
  useSketchPoseEditor: () => poseEditorQueryMock(),
  useCropSketch: () => ({
    mutateAsync: cropSketchMock,
    isPending: false,
  }),
}));

describe("SketchCropDialog", () => {
  beforeEach(() => {
    useAspectRatioStore.getState().reset();
    poseEditorQueryMock.mockReset();
    poseEditorQueryMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          beat_num: 2,
          sketch_url: "/static/sketch.png",
          width: 569,
          height: 839,
          candidates: [],
          skeleton_edges: [],
          pose_presets: {},
          skeletons: [],
        },
      },
      error: null,
      isError: false,
    });
    cropSketchMock.mockReset();
    cropSketchMock.mockResolvedValue({ ok: true, data: {} });
  });

  it("renders a fixed-aspect crop frame over the full source image", async () => {
    useAspectRatioStore.getState().setOrientation("demo", "landscape");

    render(
      <SketchCropDialog
        open
        onOpenChange={vi.fn()}
        project="demo"
        episode={1}
        beatNum={2}
      />,
    );

    expect(await screen.findByText("裁剪 16:9")).toBeInTheDocument();
    expect(screen.queryByLabelText("X")).not.toBeInTheDocument();
    expect(screen.getByAltText("B2")).toHaveClass("object-contain");

    await waitFor(() => {
      expect(screen.getByLabelText("移动裁剪区域")).toHaveStyle({
        left: "0%",
        top: "30.870083432657925%",
        width: "100%",
        height: "38.14064362336114%",
      });
    });
  });

  it("saves the fixed-aspect crop box", async () => {
    const user = userEvent.setup();
    useAspectRatioStore.getState().setOrientation("demo", "landscape");

    render(
      <SketchCropDialog
        open
        onOpenChange={vi.fn()}
        project="demo"
        episode={1}
        beatNum={2}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(cropSketchMock).toHaveBeenCalledWith({
      beatNum: 2,
      crop: { x: 0, y: 259, width: 569, height: 320 },
    });
  });

  it("adds a frontend cache buster when the sketch URL has no backend version", async () => {
    poseEditorQueryMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          beat_num: 2,
          sketch_url: "/static/sketch.png",
          width: 569,
          height: 839,
          candidates: [],
          skeleton_edges: [],
          pose_presets: {},
          skeletons: [],
        },
      },
      dataUpdatedAt: 1717000000123,
      error: null,
      isError: false,
    });

    render(
      <SketchCropDialog
        open
        onOpenChange={vi.fn()}
        project="demo"
        episode={1}
        beatNum={2}
      />,
    );

    expect(await screen.findByAltText("B2")).toHaveAttribute(
      "src",
      "/static/sketch.png?st_v=1717000000123",
    );
  });

  it("shows a load error instead of an infinite spinner", () => {
    poseEditorQueryMock.mockReturnValue({
      data: undefined,
      error: new Error("Beat 4 缺少当前草图"),
      isError: true,
    });

    render(
      <SketchCropDialog
        open
        onOpenChange={vi.fn()}
        project="demo"
        episode={1}
        beatNum={4}
      />,
    );

    expect(screen.getByText("Beat 4 缺少当前草图")).toBeInTheDocument();
    expect(screen.queryByText("Loading")).not.toBeInTheDocument();
  });

  it("drags the fixed-aspect crop frame without changing its ratio", async () => {
    useAspectRatioStore.getState().setOrientation("demo", "portrait");

    render(
      <SketchCropDialog
        open
        onOpenChange={vi.fn()}
        project="demo"
        episode={1}
        beatNum={2}
      />,
    );

    const image = await screen.findByAltText("B2");
    Object.defineProperty(image, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 569,
        bottom: 839,
        width: 569,
        height: 839,
        toJSON: () => {},
      }),
    });

    const cropBox = screen.getByLabelText("移动裁剪区域");
    await waitFor(() => {
      expect(cropBox).toHaveStyle({
        left: "0.8787346221441126%",
        width: "98.24253075571178%",
        height: "100%",
      });
    });

    fireEvent.pointerDown(cropBox, { pointerId: 1, clientX: 284, clientY: 420 });
    fireEvent.pointerMove(cropBox, { pointerId: 1, clientX: 320, clientY: 420, buttons: 1 });
    fireEvent.pointerUp(cropBox, { pointerId: 1 });

    await waitFor(() => {
      expect(cropBox).toHaveStyle({
        left: "1.7574692442882252%",
        width: "98.24253075571178%",
        height: "100%",
      });
    });
  });
});
