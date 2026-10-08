// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { getCurrentBeatContextFromNode } from "@/features/freezone/context/currentBeatContext";

describe("getCurrentBeatContextFromNode", () => {
  it("uses standalone beat_context as the current canvas-owned context", () => {
    const context = {
      schema: "beat_context.v1",
      source: "standalone",
      title: "自定义镜头上下文",
      visual_description: "{{女主_雨衣}} 在雨夜便利店门口拿着 [[红伞]]",
      detected_identities: ["女主_雨衣"],
      detected_props: ["红伞"],
      sketch_colors: { "女主_雨衣": "#FF00FF" },
      prop_marker_colors: { "红伞": "#B71C1C" },
    };

    expect(
      getCurrentBeatContextFromNode({
        id: "context",
        type: "beatContextNode",
        data: {
          context_scope: "standalone",
          beat_context: context,
          snapshot: {
            detectedIdentities: ["旧身份"],
          },
        },
      }),
    ).toEqual(context);
  });

  it("keeps standalone detected identities and props as selected state filtered by visual markers", () => {
    expect(
      getCurrentBeatContextFromNode({
        id: "context",
        type: "beatContextNode",
        data: {
          context_scope: "standalone",
          beat_context: {
            schema: "beat_context.v1",
            source: "standalone",
            visual_description: "{{女主}} 拿起 [[雨伞]]",
            detected_identities: ["女主", "旧身份"],
            detected_props: ["雨伞", "旧道具"],
          },
        },
      }),
    ).toMatchObject({
      visual_description: "{{女主}} 拿起 [[雨伞]]",
      detected_identities: ["女主"],
      detected_props: ["雨伞"],
    });
  });

  it("keeps standalone no-character and no-prop markers that never appear in visual markers", () => {
    expect(
      getCurrentBeatContextFromNode({
        id: "context",
        type: "beatContextNode",
        data: {
          context_scope: "standalone",
          beat_context: {
            schema: "beat_context.v1",
            source: "standalone",
            visual_description: "雨夜便利店门口，空无一人",
            detected_identities: ["__NO_CHARACTER__"],
            detected_props: ["__NO_PROP__"],
          },
        },
      }),
    ).toMatchObject({
      detected_identities: ["__NO_CHARACTER__"],
      detected_props: ["__NO_PROP__"],
    });
  });

  it("uses snapshot plus local edit fields for mainline BeatContextNode and ignores leaked standalone data", () => {
    expect(
      getCurrentBeatContextFromNode({
        id: "context",
        type: "beatContextNode",
        data: {
          projectId: "demo",
          episode: 1,
          beat: 4,
          beat_context: {
            schema: "beat_context.v1",
            source: "standalone",
            detected_identities: ["错误 standalone 身份"],
            detected_props: ["错误 standalone 道具"],
          },
          snapshot: {
            visualDescription: "主线同步画面",
            narrationSegment: "主线旁白",
            sceneId: "面馆",
            detectedIdentities: ["主线男"],
            detectedProps: ["纸箱"],
            sketchColors: { "主线男": "#FF00FF" },
          },
          beat_edit_fields: {
            visual_description: "画布本地画面",
            detected_identities: ["本地女"],
            detected_props: ["天线电视"],
            prop_marker_colors: { "天线电视": "#B71C1C" },
          },
          mainline_context: [
            {
              kind: "beat",
              projectId: "demo",
              episode: 1,
              beat: 4,
            },
          ],
        },
      }),
    ).toEqual({
      episode: 1,
      beat: 4,
      scene_id: "面馆",
      visual_description: "画布本地画面",
      narration_segment: "主线旁白",
      detected_identities: ["本地女", "主线男"],
      detected_props: ["天线电视", "纸箱"],
      sketch_colors: { "主线男": "#FF00FF" },
      prop_marker_colors: { "天线电视": "#B71C1C" },
    });
  });
});
