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

/**
 * 把一段贴着真实缩进抄下来的代码片段，转成不认缩进/换行只认 token 顺序的正则。
 * 这些断言原样存的是「大概长这样」的代码骨架，跟着源码缩进走很脆——旁边随便
 * 重新格式化一下（比如 prettier 改缩进级数）就会假阳性地挂掉，逼人去改测试
 * 而不是真的改坏了什么。
 */
function flexible(snippet: string): RegExp {
  const tokens = snippet.split(/\s+/).filter(Boolean);
  return new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"));
}

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
    expect(nodeSource).toMatch(
      flexible("disabled={ !videoSource || isBreakingDown || breakdownBillingRuleMissing }"),
    );
    expect(nodeSource).toMatch(
      flexible("if (breakdownBillingRuleMissing) return; void handleStartBreakdown();"),
    );
  });

  it("puts the pill on the start button, with the same disabled predicate", () => {
    // 胶囊灰态与按钮禁用必须同一口径，否则出现「按钮点不动但价签亮着」。
    expect(nodeSource).toMatch(
      flexible(
        "<CreditCostPill display={breakdownCreditCostDisplay} promotion={breakdownCreditCost.data?.data.promotion} disabled={ !videoSource || isBreakingDown || breakdownBillingRuleMissing } />",
      ),
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

  it("wires motion capture to the browser-side depth capture", () => {
    // 深度动作捕捉在浏览器里算，不提交任务、不扣费；入口在同一个下拉里，
    // 上一条已经保证这段没有价签，这里只钉住它接的是真处理器而不是占位。
    const entry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-frame-analysis"'),
      toolbarSource.indexOf('key="video-extend"'),
    );
    expect(entry).toContain("onSelect={handleVideoMotionCapture}");
    expect(entry).not.toContain('handleVideoStub("motion-capture")');
  });

  it("wires frame crop to the in-node crop mode", () => {
    // 画面裁切在浏览器里裁、不扣费；入口只切源节点的 isCropMode，框和浮条由 VideoNode 挂。
    const entry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-frame-analysis"'),
      toolbarSource.indexOf('key="video-extend"'),
    );
    expect(entry).toContain("isCropMode: true");
    expect(entry).not.toContain('handleVideoStub("frame-crop")');
  });

  it("guards crop-adjacent mode entries against an in-flight crop, with a toast", () => {
    // 裁切没传完之前不许被工具栏的其他入口打断：结果落地时会把 isCropMode
    // 拍回 false，中途切走会跟那次收尾打架，见 videoCropInFlight.ts。以前这五处
    // 都是直接 `if (isVideoCropInFlight(node.id)) return;`——静默拦截，用户点了
    // 没反应，以为是卡了。现在统一走 guardVideoCropInFlight，拦的同时提示一句。
    // 正则而不是整行硬编码：这一行后来又加了 requestVideoCropFocus 之类的具名
    // import，只要 isVideoCropInFlight 还是从这个模块来的就该算数，不用管同一行
    // 还带了谁。
    expect(toolbarSource).toMatch(
      /import\s*\{[^}]*\bisVideoCropInFlight\b[^}]*\}\s*from\s*"@\/features\/canvas\/application\/videoCrop\/videoCropInFlight";/,
    );
    expect(toolbarSource).toContain(
      't("node.videoNode.crop.busy")',
    );
    const guardDefinitionCount = (toolbarSource.match(/const guardVideoCropInFlight/g) ?? []).length;
    expect(guardDefinitionCount).toBe(1);
    // 五处旧的裸调用全部退役，只留 guardVideoCropInFlight 自己内部那一次。
    const rawCallCount = (toolbarSource.match(/if \(isVideoCropInFlight\(node\.id\)\) return;/g) ?? []).length;
    expect(rawCallCount).toBe(0);
    const guardCallCount = (toolbarSource.match(/if \(guardVideoCropInFlight\(node\.id\)\) return;/g) ?? []).length;
    expect(guardCallCount).toBe(5);

    const frameAnalysisEntry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-frame-analysis"'),
      toolbarSource.indexOf('key="video-extend"'),
    );
    expect(frameAnalysisEntry).toContain("guardVideoCropInFlight(node.id)");
    expect(toolbarSource).toMatch(
      flexible(
        "if (guardVideoCropInFlight(node.id)) return; updateNodeData(node.id, { isExtendPickMode: true, isCropMode: false });",
      ),
    );
  });

  it("clears isCropMode from both subtitle-erase entries", () => {
    // 智能去字幕 / 框选去字幕切进去字幕态时必须顺手清掉画面裁切，否则两个模式
    // 的浮层会叠在一起。
    const subtitleEntry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-subtitle-removal"'),
      toolbarSource.indexOf('key="video-separate-av"'),
    );
    const cropClearCount = subtitleEntry.match(/isCropMode: false/g)?.length ?? 0;
    expect(cropClearCount).toBe(2);
    expect(subtitleEntry).toContain("guardVideoCropInFlight(node.id)");
  });
});
