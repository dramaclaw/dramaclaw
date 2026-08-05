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
  it("quotes the product feature with output and input-video duration", () => {
    // feature key 在主体定义并导出，面板 import——两个提交入口必须同一口径。
    expect(nodeSource).toContain(
      'export const VIDEO_GENERATE_FEATURE_KEY = "freezone.video_generate"',
    );
    expect(panelSource).toContain(
      "debouncedBackend && videoInputBillingReady\n        ? VIDEO_GENERATE_FEATURE_KEY\n        : null",
    );
    expect(panelSource).toContain("video_backend: debouncedBackend");
    expect(panelSource).toContain("pricing_quantity: videoPricingQuantity");
    expect(panelSource).toContain("quantity: videoCount");
    expect(panelSource).toContain("operation: genMode");
    expect(panelSource).toContain(
      "video_input_present: debouncedVideoInputPresent",
    );
    expect(panelSource).toContain(
      "input_video_duration_seconds: debouncedInputVideoDuration",
    );
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
    // 走同一口径。
    expect(panelSource).toContain(
      "disabled={submitDisabled || videoBillingRuleMissing}",
    );
    expect(panelSource).toContain(
      "submitDisabled || videoBillingRuleMissing\n                        ? NODE_GENERATE_BUTTON_DISABLED_CLASS",
    );
  });

  it("gates the error-state regenerate path on the billing rule too", () => {
    // 估价链随面板下沉后，失败态的 RegenerateButton 是唯一在未选中时也能提交的
    // 入口。主体必须有仅错误态启用的计费探针（value 传 null 时 hook 不发请求，
    // 未选中且无错误的节点保持零估价开销），且 submitDisabled 包含该闸门——
    // handleSubmit 开头的 submitDisabled 早退由此同时覆盖两个提交入口。
    expect(nodeSource).toContain(
      "hasGenerationError && videoBackendForCost && videoInputBilling.ready\n        ? VIDEO_GENERATE_FEATURE_KEY\n        : null",
    );
    expect(nodeSource).toContain(
      "video_input_present: videoInputBilling.present",
    );
    expect(nodeSource).toContain(
      "input_video_duration_seconds: videoInputBilling.durationSeconds",
    );
    expect(nodeSource).toContain(
      "retryBillingProbe.error instanceof BillingRuleNotConfiguredError",
    );
    expect(nodeSource).toContain(
      "const submitDisabled =\n      isGenerating ||\n      videoBillingRuleMissing ||",
    );
  });
});
