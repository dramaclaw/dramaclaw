// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  "src/features/canvas/nodes/VideoOperationsPanel.tsx",
  "utf8",
);
const nodeSource = readFileSync(
  "src/features/canvas/nodes/VideoNode.tsx",
  "utf8",
);

describe("canvas video generation credit contract", () => {
  it("quotes the product feature with backend, resolution, count, and duration", () => {
    expect(panelSource).toContain(
      'const VIDEO_GENERATE_FEATURE_KEY = "freezone.video_generate"',
    );
    expect(panelSource).toContain(
      'debouncedBackend ? VIDEO_GENERATE_FEATURE_KEY : null',
    );
    expect(panelSource).toContain("video_backend: debouncedBackend");
    expect(panelSource).toContain("pricing_quantity: videoPricingQuantity");
    expect(panelSource).toContain("quantity: videoCount");
    expect(panelSource).toContain("operation: genMode");
    expect(panelSource).not.toContain(
      'useGenerationCreditCost(\n      "video_backend"',
    );
  });

  it("shows and blocks on an unconfigured video-generation rule", () => {
    expect(panelSource).toContain(
      "videoCreditCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(panelSource).toContain(
      't("common.billingRuleNotConfiguredShort")',
    );
    // billing 未配置时提交按钮与积分胶囊都必须置灰：disabled 属性与灰态样式
    // 走同一口径（估价 hook 随面板下沉后，主体的 submitDisabled 不再包含它）。
    expect(panelSource).toContain(
      "disabled={submitDisabled || videoBillingRuleMissing}",
    );
    expect(panelSource).toContain(
      "submitDisabled || videoBillingRuleMissing\n                        ? NODE_GENERATE_BUTTON_DISABLED_CLASS",
    );
  });

  it("keeps the billing gate out of VideoNode's own submitDisabled", () => {
    expect(nodeSource).toContain(
      "const submitDisabled =\n      isGenerating ||\n      !selectedVideoModel ||",
    );
    expect(nodeSource).not.toContain("videoBillingRuleMissing");
  });
});
