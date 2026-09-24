import { describe, expect, it } from "vitest";

import {
  MINIMAX_H3_MODE_ORDER,
  minimaxH3BestMode,
  minimaxH3ModeAvailability,
} from "@/features/canvas/nodes/shared/minimaxH3GenerationDecision";

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
});
