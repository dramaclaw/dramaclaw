// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import {
  canvasNodeDefinitions,
  getAllowedDownstreamTargetTypes,
  getDownstreamSpawnTypes,
  getMenuNodeDefinitions,
  getUpstreamSpawnTypes,
  isManualConnectionAllowed,
  isUpstreamConnectionAllowed,
  DOWNSTREAM_SPAWN_WHITELIST,
  UPSTREAM_SPAWN_WHITELIST,
} from "@/features/canvas/domain/nodeRegistry";

describe("canvas node registry", () => {
  it("creates standalone shot context nodes from the menu with local schema data", () => {
    const definition = canvasNodeDefinitions[CANVAS_NODE_TYPES.beatContext];
    const data = definition.createDefaultData() as Record<string, unknown>;

    expect(getMenuNodeDefinitions().map((item) => item.type)).toContain(
      CANVAS_NODE_TYPES.beatContext,
    );
    expect(definition.menuLabelKey).toBe("node.menu.beatContext");
    expect(data).toMatchObject({
      context_scope: "standalone",
      beat_context: {
        schema: "beat_context.v1",
        source: "standalone",
        title: "自定义镜头上下文",
        visual_description: "",
        narration_segment: "",
        scene_id: "",
        detected_identities: [],
        detected_props: [],
        sketch_colors: {},
        prop_marker_colors: {},
      },
      snapshot: {
        visualDescription: "",
        narrationSegment: "",
        sceneId: "",
        detectedIdentities: [],
        detectedProps: [],
        sketchColors: {},
        propMarkerColors: {},
      },
      syncStatus: "fresh",
    });
    expect(data).not.toHaveProperty("mainline_context");
  });
});

const IMAGE_NODE_TYPES = [
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.exportImage,
] as const;

describe("建边白名单", () => {
  it("音频节点连不到图片节点上", () => {
    for (const imageType of IMAGE_NODE_TYPES) {
      expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.audio, imageType)).toBe(false);
    }
  });

  it("音频节点的下游只有视频与视频合成", () => {
    // 只有这两种节点会读上游音频（视频的声轨素材 / 合成的音频轨），连到别处
    // 不会有任何效果，只是画布上一根骗人的线。
    const allTypes = Object.keys(canvasNodeDefinitions) as CanvasNodeType[];
    const reachable = allTypes.filter((type) =>
      isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.audio, type),
    );

    expect([...reachable].sort()).toEqual(
      [CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.videoCompose].sort(),
    );
  });

  it("「人声/背景音分离」留下的视频 → 音频溯源边合法", () => {
    // NodeActionToolbar 的音视频分离动作从一个视频节点同时产出「背景音」音频节点
    // 与「无声」视频节点，两条边都画回源视频。音频那条边曾被建边收口静默丢掉。
    expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio)).toBe(
      true,
    );
    expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.video)).toBe(
      true,
    );
    // 放开 video 不等于放开所有类型：图片仍然连不进音频节点。
    expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.imageGen, CANVAS_NODE_TYPES.audio)).toBe(
      false,
    );
  });

  it("风格节点只能连到图片节点，且不开放手工拖线", () => {
    const allTypes = Object.keys(canvasNodeDefinitions) as CanvasNodeType[];
    const reachable = allTypes.filter((type) =>
      isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.style, type),
    );
    expect(reachable).toEqual([CANVAS_NODE_TYPES.imageGen]);

    // 那根边由图片节点的对账逻辑跟着 styleTemplateId 建（建边收口必须放行），但
    // 手工拖线不能给 —— 一个风格节点挂到第二个图片节点上，两边的对账会把它来回
    // 改写成对方的风格，永远收敛不了。
    expect(
      isManualConnectionAllowed(CANVAS_NODE_TYPES.style, CANVAS_NODE_TYPES.imageGen),
    ).toBe(false);
  });

  it("风格节点不进创建菜单，也不进连线菜单", () => {
    // 用户手工拖出来的空风格节点没有归属的图片节点，谁也不消费它。
    expect(getMenuNodeDefinitions().map((item) => item.type)).not.toContain(
      CANVAS_NODE_TYPES.style,
    );
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.imageGen)).not.toContain(
      CANVAS_NODE_TYPES.style,
    );
  });

  it("新增的下游白名单不误伤既有连线", () => {
    // 文本 → 音频（音频节点唯一的合法上游）仍然放行。
    expect(
      isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.textAnnotation, CANVAS_NODE_TYPES.audio),
    ).toBe(true);
    // 没有下游白名单的源类型不受新表影响。
    expect(getAllowedDownstreamTargetTypes(CANVAS_NODE_TYPES.imageGen)).toBeNull();
    expect(
      isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.imageGen, CANVAS_NODE_TYPES.video),
    ).toBe(true);
    expect(
      isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.videoCompose),
    ).toBe(true);
  });

  it("菜单的产品白名单不与建边规则冲突", () => {
    // 断言落在**声明**的白名单上，而不是 getXxxSpawnTypes 的返回值 —— 那两个函数
    // 出口处就用建边规则过了一道，拿同一个谓词去断言它们的输出必然恒真，守不住
    // 任何漂移。这里查的是「产品意图里写了、但建边规则根本不放行」的格子：运行时
    // 会被静默过滤掉，菜单和白名单从此对不上，而没人会发现。
    const conflicts: string[] = [];
    for (const [source, targets] of Object.entries(DOWNSTREAM_SPAWN_WHITELIST)) {
      for (const target of targets ?? []) {
        if (!isUpstreamConnectionAllowed(source as CanvasNodeType, target)) {
          conflicts.push(`下游白名单 ${source} -> ${target}`);
        }
      }
    }
    for (const [target, sources] of Object.entries(UPSTREAM_SPAWN_WHITELIST)) {
      for (const source of sources ?? []) {
        if (!isUpstreamConnectionAllowed(source, target as CanvasNodeType)) {
          conflicts.push(`上游白名单 ${source} -> ${target}`);
        }
      }
    }

    expect(conflicts).toEqual([]);
  });
});

describe("连线菜单候选", () => {
  it("音频节点的上游菜单里没有视频", () => {
    // 视频 → 音频那条边是「人声/背景音分离」程序建的溯源边，建边收口必须放行
    // （否则存量边会被加载规范化丢掉），但用户手工连一根视频进来什么都不会发生
    // —— AudioOperationsPanel 只读 text 上游。菜单和手动拖线都不该提供。
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.audio)).toEqual([
      CANVAS_NODE_TYPES.textAnnotation,
    ]);
    expect(isManualConnectionAllowed(CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio)).toBe(
      false,
    );
    // 但建边规则本身仍放行 —— 这正是两者要分开的原因。
    expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio)).toBe(
      true,
    );
  });

  it("其余节点的菜单候选不受影响", () => {
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.video)).toEqual([
      CANVAS_NODE_TYPES.textAnnotation,
      CANVAS_NODE_TYPES.imageGen,
      CANVAS_NODE_TYPES.audio,
    ]);
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.imageGen)).toEqual([
      CANVAS_NODE_TYPES.textAnnotation,
      CANVAS_NODE_TYPES.script,
      CANVAS_NODE_TYPES.upload,
    ]);
    expect(getDownstreamSpawnTypes(CANVAS_NODE_TYPES.audio)).toEqual([
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.videoCompose,
    ]);
    // 图片类节点的下游不含音频。
    expect(getDownstreamSpawnTypes(CANVAS_NODE_TYPES.imageGen)).not.toContain(
      CANVAS_NODE_TYPES.audio,
    );
  });
});
