import { describe, expect, it } from "vitest";

import {
  DEFAULT_SHARED_MODEL_ID,
  SHARED_MODELS,
} from "@/features/canvas/ui/ProviderModelPicker";

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
