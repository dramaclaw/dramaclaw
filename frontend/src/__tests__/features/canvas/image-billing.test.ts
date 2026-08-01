import { describe, expect, it } from "vitest";

import { buildImageFeatureBillingParams } from "@/features/canvas/domain/imageBilling";

describe("buildImageFeatureBillingParams", () => {
  it("keeps a dynamic catalog and its canonical API model together", () => {
    expect(
      buildImageFeatureBillingParams(
        { catalogId: "custom-cat", apiModel: "custom-image" },
        { size: "2K", quality: "high", pricing_quantity: 2 },
      ),
    ).toEqual({
      catalog_id: "custom-cat",
      image_selection: "custom-image",
      pricing_model: "custom-image",
      pricing_quantity: 2,
      quality: "high",
      size: "2K",
    });
  });

  it("preserves the static CE fallback without inventing a catalog id", () => {
    expect(
      buildImageFeatureBillingParams(
        { apiModel: "newapi_gpt_image2" },
        { size: "1K" },
      ),
    ).toEqual({
      image_selection: "newapi_gpt_image2",
      size: "1K",
    });
  });
});
