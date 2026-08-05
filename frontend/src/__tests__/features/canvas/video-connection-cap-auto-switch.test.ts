// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 连线拦截与「接入视频/音频自动救场到 Seedance 2.0」这两条逻辑必须同源。
//
// 二者独立看都对，凑一起会死锁：用户在 Seedance 1.x 节点上连第一个视频素材，
// 救场 effect 要等这条边建起来才会触发，而拦截按救场**之前**的 1.x 算上限——
// 1.x 的 supportedModes 没有 all_reference / video_edit，跨模式上界里视频上限是 0，
// 这条边当场被拒。边永远建不起来 → 救场永远跑不了 → 用户只看到「连不上」。
//
// 注意这条死锁只在**后台目录给 1.x 配了 supportedModes** 时才出现：兜底
// VIDEO_MODELS 不带 supportedModes，上界是全模式并集（视频 3），什么都不拦。
// 所以下面的用例必须显式配上 supportedModes，否则测了个寂寞。
import { describe, expect, it } from "vitest";

import {
  referenceConnectionRejectionReason,
  videoConnectionCapModel,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";

const SEEDANCE_1X = {
  id: "seedance-1.0-pro",
  apiModel: "seedance-1.0-pro",
  supportedModes: ["text_to_video", "first_frame", "image_reference"],
};

const SEEDANCE_2 = {
  id: "seedance-2.0",
  apiModel: "seedance-2.0",
  supportedModes: ["text_to_video", "first_frame", "image_reference", "all_reference"],
};

const MODELS = [SEEDANCE_1X, SEEDANCE_2];

const NONE = { images: 0, videos: 0, audios: 0 };

/** 拦截口径：先解析出「接上这条边之后」生效的模型，再判上限。 */
function rejection(
  currentModel: (typeof MODELS)[number],
  existing: { images: number; videos: number; audios: number },
  kind: "image" | "video" | "audio",
  modelsLoading = false,
) {
  const capModel = videoConnectionCapModel({
    currentModel,
    counts: {
      videos: existing.videos + (kind === "video" ? 1 : 0),
      audios: existing.audios + (kind === "audio" ? 1 : 0),
    },
    models: MODELS,
    modelsLoading,
  });
  return referenceConnectionRejectionReason(capModel, existing, kind);
}

describe("连线拦截按救场之后的模型算上限", () => {
  it("Seedance 1.x 连第一个视频素材：按 1.x 会被拦死，按救场目标 2.0 必须放行", () => {
    // 先证明前提成立——不救场的话这条边确实被 1.x 拦掉。
    expect(referenceConnectionRejectionReason(SEEDANCE_1X, NONE, "video")).toBeTruthy();
    expect(rejection(SEEDANCE_1X, NONE, "video")).toBeNull();
  });

  it("音频素材同理", () => {
    expect(referenceConnectionRejectionReason(SEEDANCE_1X, NONE, "audio")).toBeTruthy();
    expect(rejection(SEEDANCE_1X, NONE, "audio")).toBeNull();
  });

  it("放行的是救场目标的上限，不是无上限：2.0 最多 3 个视频，第 4 个仍要拦", () => {
    expect(rejection(SEEDANCE_1X, { ...NONE, videos: 3 }, "video")).toBeTruthy();
  });

  it("图片素材不触发救场，仍按当前 1.x 的上限判", () => {
    // 救场只由视频/音频触发；图片走各自模式的兜底表，1.x 的图片参考上界是 9。
    expect(rejection(SEEDANCE_1X, NONE, "image")).toBeNull();
    expect(rejection(SEEDANCE_1X, { ...NONE, images: 9 }, "image")).toBeTruthy();
  });

  it("目录还没落定时不预判救场：此刻 models 是兜底表，effect 那边也按兵不动", () => {
    expect(rejection(SEEDANCE_1X, NONE, "video", true)).toBeTruthy();
  });

  it("列表里没有 2.0 时救不了，拦截口径不变", () => {
    const capModel = videoConnectionCapModel({
      currentModel: SEEDANCE_1X,
      counts: { videos: 1, audios: 0 },
      models: [SEEDANCE_1X],
      modelsLoading: false,
    });
    expect(capModel).toBe(SEEDANCE_1X);
    expect(referenceConnectionRejectionReason(capModel, NONE, "video")).toBeTruthy();
  });

  it("当前已经是 2.0 时原样返回，不做任何替换", () => {
    expect(
      videoConnectionCapModel({
        currentModel: SEEDANCE_2,
        counts: { videos: 1, audios: 0 },
        models: MODELS,
        modelsLoading: false,
      }),
    ).toBe(SEEDANCE_2);
  });
});
