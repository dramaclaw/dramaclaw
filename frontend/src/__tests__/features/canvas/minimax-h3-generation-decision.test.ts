import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import type { MediaModelParameterDefinition } from "@/api/ops";
import {
  submitFreezoneVideoGen,
  submitFreezoneVideoI2v,
  submitFreezoneVideoKeyframes,
  submitFreezoneVideoOmniGen,
} from "@/api/ops";

import {
  MINIMAX_H3_MODE_ORDER,
  minimaxH3BestMode,
  minimaxH3ModeAvailability,
} from "@/features/canvas/nodes/shared/minimaxH3GenerationDecision";
import { filterMediaModelParamsForMode } from "@/features/canvas/ui/MediaModelParameterChip";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiCallEnvelope: vi.fn(),
  apiClient: {},
}));

beforeEach(() => {
  vi.mocked(apiCall).mockReset();
  vi.mocked(apiCall).mockResolvedValue({ job_id: "job-1" });
});

const H3_COMMON_MODEL_PARAMS = {
  quality_mode: "balanced",
  inference_steps: 6,
  seed: 42,
};

const H3_ALL_REFERENCE_MODEL_PARAMS = {
  ...H3_COMMON_MODEL_PARAMS,
  model_mode: "dual_pass",
};

const H3_PARAMETER_DEFINITIONS: MediaModelParameterDefinition[] = [
  {
    key: "quality_mode",
    label: "quality",
    control: "select",
    requestPath: "metadata.quality_mode",
  },
  {
    key: "inference_steps",
    label: "steps",
    control: "number",
    requestPath: "metadata.inference_steps",
  },
  {
    key: "model_mode",
    label: "strategy",
    control: "select",
    requestPath: "metadata.model_mode",
    modes: ["all_reference"],
  },
  {
    key: "seed",
    label: "seed",
    control: "number",
    requestPath: "metadata.seed",
  },
];

const sharedSubmission = {
  aspectRatio: "21:9",
  resolution: "2k",
  durationSeconds: 15,
  generateAudio: false,
  model: "MiniMax-H3",
  modelParams: H3_COMMON_MODEL_PARAMS,
};

describe("MiniMax H3 generation decision", () => {
  it("exposes only the four LibLib-aligned modes", () => {
    expect(MINIMAX_H3_MODE_ORDER).toEqual([
      "textToVideo",
      "allReference",
      "imageToVideo",
      "firstLastFrame",
    ]);
  });

  it.each([
    [{ images: 0, videos: 0, audios: 0 }, "textToVideo"],
    [{ images: 1, videos: 0, audios: 0 }, "imageToVideo"],
    [{ images: 2, videos: 0, audios: 0 }, "firstLastFrame"],
    [{ images: 3, videos: 0, audios: 0 }, "allReference"],
    [{ images: 1, videos: 0, audios: 1 }, "allReference"],
    [{ images: 0, videos: 1, audios: 0 }, "allReference"],
  ] as const)("chooses %s as %s", (counts, expected) => {
    expect(minimaxH3BestMode(counts)).toBe(expected);
  });

  it("keeps a valid explicit full-reference choice", () => {
    expect(
      minimaxH3BestMode(
        { images: 1, videos: 0, audios: 0 },
        "allReference",
      ),
    ).toBe("allReference");
  });

  it("requires exactly one image for image-to-video", () => {
    const decision = minimaxH3ModeAvailability("imageToVideo", {
      images: 2,
      videos: 0,
      audios: 0,
    });
    expect(decision.enabled).toBe(false);
    expect(decision.reasonKey).toBe(
      "node.videoOps.modeDisabled.h3ImageExactlyOne",
    );
  });

  it("requires exactly two images and no ignored media for first/last frame", () => {
    expect(
      minimaxH3ModeAvailability("firstLastFrame", {
        images: 2,
        videos: 0,
        audios: 0,
      }).enabled,
    ).toBe(true);
    const mixed = minimaxH3ModeAvailability("firstLastFrame", {
      images: 2,
      videos: 0,
      audios: 1,
    });
    expect(mixed.enabled).toBe(false);
    expect(mixed.reasonKey).toBe(
      "node.videoOps.modeDisabled.h3UseAllReferenceForMixed",
    );
  });

  it("enforces all-reference type limits", () => {
    expect(
      minimaxH3ModeAvailability("allReference", {
        images: 9,
        videos: 3,
        audios: 3,
      }).enabled,
    ).toBe(true);
    expect(
      minimaxH3ModeAvailability("allReference", {
        images: 10,
        videos: 0,
        audios: 0,
      }).reasonKey,
    ).toBe("node.videoOps.modeDisabled.h3MaxImages");
  });

  it("removes the all-reference strategy when another mode is selected", () => {
    expect(
      filterMediaModelParamsForMode(
        H3_PARAMETER_DEFINITIONS,
        H3_ALL_REFERENCE_MODEL_PARAMS,
        "textToVideo",
      ),
    ).toEqual(H3_COMMON_MODEL_PARAMS);
    expect(
      filterMediaModelParamsForMode(
        H3_PARAMETER_DEFINITIONS,
        H3_ALL_REFERENCE_MODEL_PARAMS,
        "allReference",
      ),
    ).toEqual(H3_ALL_REFERENCE_MODEL_PARAMS);
  });

  it.each([
    [
      "textToVideo",
      H3_COMMON_MODEL_PARAMS,
      () => submitFreezoneVideoGen("project-1", {
        prompt: "Move",
        genMode: "textToVideo",
        ...sharedSubmission,
      }),
    ],
    [
      "imageToVideo",
      H3_COMMON_MODEL_PARAMS,
      () => submitFreezoneVideoI2v("project-1", {
        imageUrls: ["/static/reference.png"],
        prompt: "Move",
        genMode: "imageToVideo",
        ...sharedSubmission,
      }),
    ],
    [
      "firstLastFrame",
      H3_COMMON_MODEL_PARAMS,
      () => submitFreezoneVideoKeyframes("project-1", {
        firstFrameUrl: "/static/first.png",
        lastFrameUrl: "/static/last.png",
        prompt: "Move",
        genMode: "firstLastFrame",
        ...sharedSubmission,
      }),
    ],
    [
      "allReference",
      H3_ALL_REFERENCE_MODEL_PARAMS,
      () => submitFreezoneVideoOmniGen("project-1", {
        prompt: "Move",
        references: [{ type: "image", url: "/static/reference.png" }],
        genMode: "allReference",
        ...sharedSubmission,
        modelParams: H3_ALL_REFERENCE_MODEL_PARAMS,
      }),
    ],
  ] as const)("forwards every visible H3 parameter for %s", async (
    mode,
    expectedModelParams,
    submit,
  ) => {
    await submit();

    const options = vi.mocked(apiCall).mock.calls[0]?.[1] as {
      json?: Record<string, unknown>;
    };
    expect(options.json).toMatchObject({
      aspect_ratio: "21:9",
      resolution: "2k",
      duration_seconds: 15,
      generate_audio: false,
      model: "MiniMax-H3",
      model_id: "MiniMax-H3",
      gen_mode: mode,
      model_params: expectedModelParams,
    });
  });
});
