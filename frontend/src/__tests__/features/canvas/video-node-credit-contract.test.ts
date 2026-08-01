// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nodeSource = readFileSync(
  "src/features/canvas/nodes/VideoNode.tsx",
  "utf8",
);

describe("canvas video generation credit contract", () => {
  it("quotes the product feature with backend, resolution, count, and duration", () => {
    expect(nodeSource).toContain(
      'const VIDEO_GENERATE_FEATURE_KEY = "freezone.video_generate"',
    );
    expect(nodeSource).toContain(
      'debouncedBackend ? VIDEO_GENERATE_FEATURE_KEY : null',
    );
    expect(nodeSource).toContain("video_backend: debouncedBackend");
    expect(nodeSource).toContain("pricing_quantity: videoPricingQuantity");
    expect(nodeSource).toContain("quantity: videoCount");
    expect(nodeSource).toContain("operation: genMode");
    expect(nodeSource).not.toContain(
      'useGenerationCreditCost(\n      "video_backend"',
    );
  });

  it("shows and blocks on an unconfigured video-generation rule", () => {
    expect(nodeSource).toContain(
      "videoCreditCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(nodeSource).toContain(
      't("common.billingRuleNotConfiguredShort")',
    );
    expect(nodeSource).toContain(
      "isGenerating ||\n      videoBillingRuleMissing ||",
    );
  });
});
