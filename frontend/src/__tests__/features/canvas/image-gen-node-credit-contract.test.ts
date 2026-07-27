// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nodeSource = readFileSync(
  "src/features/canvas/nodes/ImageGenNode.tsx",
  "utf8",
);

describe("canvas image generation credit contract", () => {
  it("quotes the explicit image-generation feature with model details and count", () => {
    expect(nodeSource).toContain(
      "imageSelectionForCost ? IMAGE_GENERATE_FEATURE_KEY : null",
    );
    expect(nodeSource).toContain("image_selection: imageSelectionForCost");
    expect(nodeSource).toContain("pricing_quantity: imageQuantity");
    expect(nodeSource).toContain("quantity: imageQuantity");
  });

  it("shows and blocks on an unconfigured image-generation rule", () => {
    expect(nodeSource).toContain(
      "imageCreditCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(nodeSource).toContain("t('common.billingRuleNotConfiguredShort')");
    expect(nodeSource).toContain("const submitDisabled =");
    expect(nodeSource).toContain("imageBillingRuleMissing ||");
  });
});
