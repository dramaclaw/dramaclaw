// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 低缩放档下除豁免类型外的节点都会被真卸载、换成 LodShellNode。没量过尺寸的节点
// （首屏就在低缩放档恢复，组件从没渲染过）只能靠这张兜底表画盒子，漏登记就会拿
// 400×300 的通用值 —— tsc 查不出来，只能靠这条棘轮。
import { describe, expect, it } from "vitest";

import { LOD_SHELL_EXEMPT_TYPES } from "@/features/canvas/application/canvasLod";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { SHELL_FALLBACK_SIZES } from "@/features/canvas/nodes/LodShellNode";

describe("SHELL_FALLBACK_SIZES", () => {
  it("covers every node type that can actually be shelled", () => {
    const missing = Object.values(CANVAS_NODE_TYPES)
      .filter((type) => !LOD_SHELL_EXEMPT_TYPES.has(type))
      .filter((type) => !SHELL_FALLBACK_SIZES[type])
      .sort();

    expect(missing).toEqual([]);
  });

  it("does not carry sizes for types that never get shelled", () => {
    const pointless = Object.keys(SHELL_FALLBACK_SIZES)
      .filter((type) => LOD_SHELL_EXEMPT_TYPES.has(type))
      .sort();

    expect(pointless).toEqual([]);
  });
});
