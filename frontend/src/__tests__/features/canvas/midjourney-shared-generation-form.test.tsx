import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import { useImageGenerationForm } from "@/features/canvas/nodes/shared/useImageGenerationForm";
import { useCanvasStore } from "@/stores/canvasStore";

const mocks = vi.hoisted(() => ({
  quote: vi.fn(),
  submit: vi.fn(),
  completed: vi.fn(),
}));
vi.mock("@/lib/url-params", async (original) => ({
  ...(await original<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: "demo", canvas: "default" }),
}));
vi.mock("@/features/canvas/hooks/useFreezoneImageModels", () => ({
  useFreezoneImageModels: () => ({
    isLoading: false,
    isFallback: false,
    models: [
      {
        id: "mj",
        catalogId: "mj-catalog",
        apiModel: "mj_imagine",
        providerId: "newapi",
        adapter: "relayclaw_midjourney",
        supportedOperations: ["imagine", "edit", "blend", "upscale"],
        referenceImageMax: 5,
        request: {
          parameters: [
            {
              key: "reference_mode",
              requestPath: "midjourney.reference_mode",
              control: "select",
              modes: ["image_to_image"],
              options: [
                "image_prompt",
                "style_reference",
                "omni_reference",
                "edit",
                "blend",
              ],
            },
          ],
        },
      },
    ],
  }),
}));
vi.mock("@/features/canvas/hooks/useFreezoneCameraOptions", () => ({
  useFreezoneCameraOptions: () => ({ options: null }),
}));
vi.mock("@/features/canvas/hooks/useFreezoneStyleTemplates", () => ({
  useFreezoneStyleTemplates: () => ({
    templates: [],
    assetBase: "",
    isLoading: false,
    error: null,
    retry: vi.fn(),
  }),
}));
vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: (...args: unknown[]) => {
    mocks.quote(...args);
    return { data: undefined, error: null };
  },
}));
vi.mock("@/api/ops", async (original) => ({
  ...(await original<typeof import("@/api/ops")>()),
  submitFreezoneGen: (...args: unknown[]) => mocks.submit(...args),
}));
vi.mock("@/api/tasks", async (original) => ({
  ...(await original<typeof import("@/api/tasks")>()),
  awaitTaskCompletion: (...args: unknown[]) => mocks.completed(...args),
}));

function seed(data: Record<string, unknown>, referenceCount = 0) {
  const node = {
    id: "image",
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: { model: "mj", prompt: "cat", ...data },
  } as CanvasNode;
  const refs = Array.from(
    { length: referenceCount },
    (_, index) =>
      ({
        id: `ref-${index}`,
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: `/ref-${index}.png` },
      }) as CanvasNode,
  );
  useCanvasStore.getState().setCanvasData(
    [node, ...refs],
    refs.map((ref) => ({ id: ref.id, source: ref.id, target: "image" })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submit.mockResolvedValue({
    task_key: "gen:1",
    task_type: "freezone_gen",
    job_id: "1",
  });
  mocks.completed.mockResolvedValue({
    result: {
      output_url: "/grid.png",
      midjourney: {
        task_id: "upstream-1",
        operation: "blend",
        buttons: [{ label: "U1", custom_id: "one" }],
      },
    },
  });
});

describe("Midjourney in the shared image generation form", () => {
  it("quotes pure text generation as imagine and removes a stale reference mode", async () => {
    seed({ modelParams: { reference_mode: "blend" } });
    const { result } = renderHook(() => useImageGenerationForm("image"));
    await waitFor(() =>
      expect(
        result.current.formProps.modelParams?.reference_mode,
      ).toBeUndefined(),
    );
    expect(mocks.quote).toHaveBeenLastCalledWith(
      "feature",
      "freezone.image_generate",
      expect.objectContaining({
        params: expect.objectContaining({ operation: "imagine" }),
      }),
    );
    expect(result.current.formProps.modelParameters?.[0].options).toEqual([]);
  });

  it("submits two-image blend without a prompt and preserves grid action context", async () => {
    seed({ prompt: "", modelParams: { reference_mode: "blend" } }, 2);
    const { result } = renderHook(() => useImageGenerationForm("image"));
    expect(result.current.submitDisabled).toBe(false);
    expect(result.current.formProps.hideImagineControls).toBe(true);
    expect(mocks.quote).toHaveBeenLastCalledWith(
      "feature",
      "freezone.image_generate",
      expect.objectContaining({
        params: expect.objectContaining({ operation: "blend" }),
      }),
    );
    await act(async () => {
      await result.current.submit();
    });
    expect(mocks.submit).toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({
        modelId: "mj-catalog",
        genMode: "image_to_image",
        referenceUrls: ["/ref-0.png", "/ref-1.png"],
        modelParams: { reference_mode: "blend" },
      }),
    );
    expect(
      useCanvasStore.getState().nodes.find((node) => node.id === "image")?.data
        .midjourneyGridSource,
    ).toEqual({
      imageUrl: "/grid.png",
      task: {
        task_id: "upstream-1",
        operation: "blend",
        buttons: [{ label: "U1", custom_id: "one" }],
      },
    });
  });

  it("falls back from blend when references drop to one and requires an edit prompt", async () => {
    seed({ prompt: "", modelParams: { reference_mode: "blend" } }, 1);
    const { result } = renderHook(() => useImageGenerationForm("image"));
    await waitFor(() =>
      expect(result.current.formProps.modelParams?.reference_mode).toBe(
        "image_prompt",
      ),
    );
    expect(result.current.formProps.modelParameters?.[0].options).not.toContain(
      "blend",
    );
    act(() =>
      useCanvasStore
        .getState()
        .updateNodeData("image", { modelParams: { reference_mode: "edit" } }),
    );
    expect(result.current.submitDisabled).toBe(true);
  });
});
