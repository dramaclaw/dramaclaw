import { describe, expect, it } from "vitest";
import { readLastVideoModel, writeLastVideoModel } from "@/features/canvas/domain/lastVideoModel";

import { DEFAULT_SHARED_MODEL_ID } from "@/features/canvas/domain/defaultModelIds";
import { SHARED_MODELS, VIDEO_MODELS } from "@/features/canvas/domain/modelOptions";

describe("ProviderModelPicker image model defaults", () => {
  it("uses the current NewAPI image model as the static fallback default", () => {
    expect(DEFAULT_SHARED_MODEL_ID).toBe("newapi_gpt_image2");
  });

  it("keeps static fallback labels aligned with the current backend model names", () => {
    expect(SHARED_MODELS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "newapi_gpt_image2",
          label: "LingShan-G2",
        }),
        expect.objectContaining({
          id: "newapi_nanobanana2",
          label: "LingShan-NB-2",
        }),
      ]),
    );
  });
});

it("does not reintroduce retired Seedance models while the video catalog is unavailable", () => {
  const ids = VIDEO_MODELS.map(model => model.id);
  expect(ids).not.toContain("newapi_seedance-1.0-pro-fast");
  expect(ids).not.toContain("newapi_seedance-1.5-pro");
  expect(ids).toContain("newapi_seedance-2.0-fast");
});

it("does not carry a retired preference into new nodes", () => {
  try {
    writeLastVideoModel("huimeng_seedance-1.5-pro");
    expect(readLastVideoModel()).toBeNull();
    writeLastVideoModel("newapi_seedance-2.0");
    expect(readLastVideoModel()).toBe("newapi_seedance-2.0");
  } finally {
    window.localStorage.removeItem("canvas.lastVideoModel");
  }
});
