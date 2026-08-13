// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 目录参数按 `modes` 过滤：`MediaModelParameterChip` 拿不到模式时，声明了 modes 的
// 参数**一个都不渲染**，用户在 UI 上根本看不到、也就无从设置。
//
// 三个图片节点里只有 ImageEditNode 有模式选择器，而它的 `data.generationMode` 在
// 用户没手动选过之前是 undefined；ImageGenNode / StoryboardGenNode 的节点数据里
// 压根没有这个字段。所以「把 `data.generationMode` 直接递给控件」等于三处全都是
// undefined —— 控件永远藏参数。这里锁住的就是「递给控件的必须是推导后的模式」。
//
// 提交侧的模式由 `catalog-image-model-params.test.ts` 覆盖到 ops payload；这条只
// 盯住渲染侧的接线，因为控件不显示的话提交侧再对也没有值可提交。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function nodeSource(name: string): string {
  return readFileSync(
    resolve(process.cwd(), `src/features/canvas/nodes/${name}.tsx`),
    "utf8",
  );
}

/** `<MediaModelParameterChip ... />` 这一段的原文。 */
function chipBlock(source: string): string {
  const start = source.indexOf("<MediaModelParameterChip");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("/>", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("图片节点递给模型参数控件的模式", () => {
  it("ImageEditNode 用推导后的模式，不是裸 data.generationMode", () => {
    const source = nodeSource("ImageEditNode");
    // 推导：没手动选过模式时，有上游图 → 全能参考，没有 → 文生图。
    expect(source).toContain("const generationMode = data.generationMode ??");
    expect(chipBlock(source)).toContain("mode={generationMode}");
    // 提交侧同一个值 —— 控件显示的和最终发出去的模式必须是同一个。
    expect(source).not.toContain("generationMode: data.generationMode,");
  });

  it("ImageGenNode 按有无参考图推导模式", () => {
    const source = nodeSource("ImageGenNode");
    expect(source).toContain(
      "const generationMode = orderedReferenceUrls.length > 0 ? 'image_to_image' : 'text_to_image';",
    );
    expect(chipBlock(source)).toContain("mode={generationMode}");
    expect(source).toContain("generationMode,");
  });

  it("StoryboardGenNode 恒为图生图（宫格图总是作为参考图提交）", () => {
    const source = nodeSource("StoryboardGenNode");
    expect(source).toContain("const STORYBOARD_GENERATION_MODE = 'image_to_image';");
    expect(chipBlock(source)).toContain("mode={STORYBOARD_GENERATION_MODE}");
    expect(source).toContain("generationMode: STORYBOARD_GENERATION_MODE,");
  });

  it("没有任何一个图片节点还把裸 data.generationMode 递给控件", () => {
    for (const name of ["ImageEditNode", "ImageGenNode", "StoryboardGenNode"]) {
      expect(chipBlock(nodeSource(name))).not.toContain("data.generationMode");
    }
  });
});
