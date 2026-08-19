// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 拉片是要扣费的（与视频解读同族，共用 freezone.video_analyze 那条规则）。
// 扣费点在节点里的「开始拉片」，不在工具条那个入口 —— 工具条只是 addNode，
// 点它一分不扣。价签必须钉在真正花钱的那颗按钮上，钉错地方等于骗用户。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nodeSource = readFileSync(
  "src/features/canvas/nodes/VideoBreakdownNode.tsx",
  "utf8",
);
const toolbarSource = readFileSync(
  "src/features/canvas/ui/NodeActionToolbar.tsx",
  "utf8",
);

describe("canvas video breakdown credit contract", () => {
  it("quotes the shared video_analyze feature under its own ledger operation", () => {
    // 与 EE 侧 FEATURE_BILLING_SPECS["freezone_video_breakdown"] 以及 CE 路由
    // _enqueue_or_start_freezone_video_analysis 的 billing_operation 对齐。
    expect(nodeSource).toContain('const breakdownCreditCost = useGenerationCreditCost(');
    expect(nodeSource).toContain('"feature",\n      "freezone.video_analyze",');
    expect(nodeSource).toContain(
      '{ surface: "canvas", params: { operation: "video_breakdown" } }',
    );
  });

  it("shows and blocks on an unconfigured rule", () => {
    expect(nodeSource).toContain(
      "breakdownCreditCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(nodeSource).toContain('t("common.billingRuleNotConfiguredShort")');
    // 未配置价格规则时按钮必须真的点不动，而不是只把胶囊改成「需配置」。
    expect(nodeSource).toContain(
      "disabled={\n              !videoSource || isBreakingDown || breakdownBillingRuleMissing\n            }",
    );
    expect(nodeSource).toContain(
      "if (breakdownBillingRuleMissing) return;\n              void handleStartBreakdown();",
    );
  });

  it("puts the pill on the start button, with the same disabled predicate", () => {
    // 胶囊灰态与按钮禁用必须同一口径，否则出现「按钮点不动但价签亮着」。
    expect(nodeSource).toContain(
      "<CreditCostPill\n              display={breakdownCreditCostDisplay}\n              promotion={breakdownCreditCost.data?.data.promotion}\n              disabled={\n                !videoSource || isBreakingDown || breakdownBillingRuleMissing\n              }\n            />",
    );
  });

  it("keeps the toolbar entry price-free because it only spawns the node", () => {
    // 工具条的「逐帧拉片」= addNode + addEdge，不提交任务、不扣费。挂价签会让
    // 用户以为点一下就花钱（对比「解析」：那颗是直接提交，所以它带价签）。
    const entry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-frame-analysis"'),
      toolbarSource.indexOf('key="video-extend"'),
    );
    expect(entry).not.toBe("");
    expect(entry).not.toContain("CreditCostPill");
  });
});
