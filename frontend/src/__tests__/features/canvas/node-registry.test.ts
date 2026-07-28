// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import {
  canvasNodeDefinitions,
  getAllowedDownstreamTargetTypes,
  getDownstreamSpawnTypes,
  getMenuNodeDefinitions,
  isUpstreamConnectionAllowed,
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

  it("菜单给出的下游候选必然是建边规则放行的", () => {
    // 这条守的是「菜单能创建、边却被拒」这类漂移：用户点了以后新节点建出来了，
    // 边被 store 的建边收口丢掉，画布上只剩一个连不上的孤立节点。
    const orphans: string[] = [];
    for (const originType of Object.keys(canvasNodeDefinitions) as CanvasNodeType[]) {
      for (const spawnType of getDownstreamSpawnTypes(originType)) {
        if (!isUpstreamConnectionAllowed(originType, spawnType)) {
          orphans.push(`${originType} -> ${spawnType}`);
        }
      }
    }

    expect(orphans).toEqual([]);
  });
});
