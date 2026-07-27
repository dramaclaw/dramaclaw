// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { VideoGenMode } from "@/features/canvas/domain/canvasNodes";
import {
  audioReferenceDurationRejection,
  formatAudioDurationClips,
  isGrokVideoChannelModel,
  isHappyHorseVideoModel,
  isSeedance1xVideoModel,
  isSeedance2VideoModel,
  isVideoModeSupportedByModel,
  videoEmptyStateCtaModes,
  videoModeRequiresPrompt,
  videoSubmitMediaRejectionReason,
  videoUpstreamImageDefaultMode,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";

// 对齐后端 freezone/video_node.py 的真实模型 id（apiModel == id == 后端 model）。
const SEEDANCE2_FAST = "newapi_seedance-2.0-fast";
const SEEDANCE2_VALUE = "newapi_seedance-2.0-fast-value";
const SEEDANCE10_PRO_FAST = "newapi_seedance-1.0-pro-fast";
const SEEDANCE15_PRO = "newapi_seedance-1.5-pro";
const HAPPYHORSE = "newapi_happyhorse-1.0";

describe("video model family detection", () => {
  it("classifies Seedance 2.0 variants (not 1.x)", () => {
    for (const id of [SEEDANCE2_FAST, SEEDANCE2_VALUE, "seedance-2.0"]) {
      expect(isSeedance2VideoModel(id)).toBe(true);
      expect(isSeedance1xVideoModel(id)).toBe(false);
    }
  });

  it("classifies Seedance 1.x variants (not 2.0)", () => {
    for (const id of [SEEDANCE10_PRO_FAST, SEEDANCE15_PRO, "seedance-1.0"]) {
      expect(isSeedance1xVideoModel(id)).toBe(true);
      expect(isSeedance2VideoModel(id)).toBe(false);
    }
  });

  it("classifies HappyHorse and Grok channels distinctly", () => {
    expect(isHappyHorseVideoModel(HAPPYHORSE)).toBe(true);
    expect(isSeedance2VideoModel(HAPPYHORSE)).toBe(false);
    expect(isSeedance1xVideoModel(HAPPYHORSE)).toBe(false);
    expect(isGrokVideoChannelModel("newapi_grok-video-channel")).toBe(true);
  });

  it("tolerates null / empty / oddly-formatted ids without misclassifying", () => {
    for (const id of [null, undefined, "", "  "]) {
      expect(isSeedance2VideoModel(id)).toBe(false);
      expect(isSeedance1xVideoModel(id)).toBe(false);
      expect(isHappyHorseVideoModel(id)).toBe(false);
    }
    // 分隔符不敏感：normalize 后 `seedance20` 仍是 2.0，不会漏成 1.x。
    expect(isSeedance2VideoModel("SEEDANCE 2.0 FAST")).toBe(true);
  });
});

describe("videoEmptyStateCtaModes — CTA by model capability", () => {
  it("Seedance 2.0 → 全能参考 / 图片参考 / 首尾帧", () => {
    expect(videoEmptyStateCtaModes(SEEDANCE2_FAST)).toEqual([
      "allReference",
      "imageReference",
      "firstLastFrame",
    ]);
  });

  it("Seedance 1.x → 只给「首帧」(全能参考会 400、首尾帧尾帧被静默丢弃、多图不支持)", () => {
    for (const id of [SEEDANCE10_PRO_FAST, SEEDANCE15_PRO]) {
      const cta = videoEmptyStateCtaModes(id);
      expect(cta).toEqual(["imageToVideo"]);
      // 回归护栏：1.x 空态绝不出现只有 2.0 支持的入口。
      expect(cta).not.toContain("allReference");
      expect(cta).not.toContain("firstLastFrame");
    }
  });

  it("HappyHorse → 首帧 / 图片参考 (无全能参考 / 首尾帧)", () => {
    const cta = videoEmptyStateCtaModes(HAPPYHORSE);
    expect(cta).toEqual(["imageToVideo", "imageReference"]);
    expect(cta).not.toContain("allReference");
    expect(cta).not.toContain("firstLastFrame");
  });

  it("每个 CTA 模式都能被同一模型支持 (CTA ⊆ supported)", () => {
    for (const id of [SEEDANCE2_FAST, SEEDANCE10_PRO_FAST, HAPPYHORSE]) {
      for (const mode of videoEmptyStateCtaModes(id)) {
        expect(isVideoModeSupportedByModel(mode, id)).toBe(true);
      }
    }
  });
});

describe("isVideoModeSupportedByModel — mode gating by model", () => {
  const commonModes: VideoGenMode[] = ["textToVideo", "imageToVideo", "imageReference"];

  it("全能参考 / 首尾帧仅 Seedance 2.0", () => {
    for (const mode of ["allReference", "firstLastFrame"] as VideoGenMode[]) {
      expect(isVideoModeSupportedByModel(mode, SEEDANCE2_FAST)).toBe(true);
      expect(isVideoModeSupportedByModel(mode, SEEDANCE10_PRO_FAST)).toBe(false);
      expect(isVideoModeSupportedByModel(mode, SEEDANCE15_PRO)).toBe(false);
      expect(isVideoModeSupportedByModel(mode, HAPPYHORSE)).toBe(false);
    }
  });

  it("文生 / 首帧 / 图片参考所有视频模型都支持", () => {
    for (const id of [SEEDANCE2_FAST, SEEDANCE10_PRO_FAST, HAPPYHORSE]) {
      for (const mode of commonModes) {
        expect(isVideoModeSupportedByModel(mode, id)).toBe(true);
      }
    }
  });

  it("视频编辑仅 HappyHorse", () => {
    expect(isVideoModeSupportedByModel("videoEdit", HAPPYHORSE)).toBe(true);
    expect(isVideoModeSupportedByModel("videoEdit", SEEDANCE2_FAST)).toBe(false);
    expect(isVideoModeSupportedByModel("videoEdit", SEEDANCE10_PRO_FAST)).toBe(false);
  });
});

describe("videoUpstreamImageDefaultMode — auto-derived default on first image", () => {
  it("Seedance 2.0 接图默认「全能参考」", () => {
    expect(videoUpstreamImageDefaultMode(SEEDANCE2_FAST)).toBe("allReference");
  });

  it("Seedance 1.x 接图默认「首帧」而非全能参考 (否则提交必 400)", () => {
    expect(videoUpstreamImageDefaultMode(SEEDANCE10_PRO_FAST)).toBe("imageToVideo");
    expect(videoUpstreamImageDefaultMode(SEEDANCE15_PRO)).toBe("imageToVideo");
  });
});

describe("videoSubmitMediaRejectionReason — 提交前素材守卫 (P1/P2)", () => {
  const none = { images: 0, videos: 0, audios: 0 };

  it("Seedance 1.x：接入视频 → 拦 (P1 静默丢视频)", () => {
    expect(
      videoSubmitMediaRejectionReason("imageToVideo", SEEDANCE10_PRO_FAST, { ...none, videos: 1 }),
    ).toBeTruthy();
    expect(
      videoSubmitMediaRejectionReason("textToVideo", SEEDANCE10_PRO_FAST, { ...none, videos: 1 }),
    ).toBeTruthy();
  });

  it("Seedance 1.x：接入音频 → 拦 (P1 静默丢音频)", () => {
    expect(
      videoSubmitMediaRejectionReason("imageToVideo", SEEDANCE10_PRO_FAST, { ...none, audios: 1 }),
    ).toBeTruthy();
  });

  it("Seedance 1.x：>1 图 → 拦 (P2 多图 400)，无论 imageReference 还是 imageToVideo", () => {
    for (const mode of ["imageReference", "imageToVideo"] as VideoGenMode[]) {
      expect(
        videoSubmitMediaRejectionReason(mode, SEEDANCE10_PRO_FAST, { images: 2, videos: 0, audios: 0 }),
      ).toBeTruthy();
      expect(
        videoSubmitMediaRejectionReason(mode, SEEDANCE15_PRO, { images: 9, videos: 0, audios: 0 }),
      ).toBeTruthy();
    }
  });

  it("Seedance 1.x：单图 / 纯文本 → 放行", () => {
    expect(
      videoSubmitMediaRejectionReason("imageToVideo", SEEDANCE10_PRO_FAST, { ...none, images: 1 }),
    ).toBeNull();
    expect(
      videoSubmitMediaRejectionReason("imageReference", SEEDANCE10_PRO_FAST, { ...none, images: 1 }),
    ).toBeNull();
    expect(videoSubmitMediaRejectionReason("textToVideo", SEEDANCE10_PRO_FAST, none)).toBeNull();
  });

  it("Seedance 2.0：全能参考消费视频/音频/多图 → 放行", () => {
    expect(
      videoSubmitMediaRejectionReason("allReference", SEEDANCE2_FAST, { images: 9, videos: 1, audios: 1 }),
    ).toBeNull();
  });

  it("HappyHorse：视频编辑消费视频、图片参考消费多图 → 放行", () => {
    expect(
      videoSubmitMediaRejectionReason("videoEdit", HAPPYHORSE, { ...none, videos: 1 }),
    ).toBeNull();
    expect(
      videoSubmitMediaRejectionReason("imageReference", HAPPYHORSE, { images: 5, videos: 0, audios: 0 }),
    ).toBeNull();
  });
});

describe("audioReferenceDurationRejection — 提交前音频时长守卫", () => {
  const clip = (label: string, durationMs: number | null) => ({ label, durationMs });

  it("单条短于 1.8s → 拦，并指名是哪条 (厂商 DurationTooShort)", () => {
    const rejection = audioReferenceDurationRejection([
      clip("bgm.mp3", 5_000),
      clip("sfx.wav", 900),
    ]);
    expect(rejection).toEqual({
      kind: "tooShort",
      clips: [{ label: "sfx.wav", durationMs: 900 }],
    });
  });

  it("恰好 1.8s 放行，1.799s 拦 (边界取闭区间，与厂商 1.8s 下限一致)", () => {
    expect(audioReferenceDurationRejection([clip("a", 1_800)])).toBeNull();
    expect(audioReferenceDurationRejection([clip("a", 1_799)])?.kind).toBe("tooShort");
  });

  it("总时长超 15.2s → 拦；15.2s 整放行", () => {
    expect(audioReferenceDurationRejection([clip("a", 15_200)])).toBeNull();
    expect(audioReferenceDurationRejection([clip("a", 15_201)])).toEqual({
      kind: "totalTooLong",
      totalMs: 15_201,
    });
    expect(
      audioReferenceDurationRejection([clip("a", 8_000), clip("b", 8_000)])?.kind,
    ).toBe("totalTooLong");
  });

  it("既有太短又总时长超限时优先报太短 (能指到具体哪条，更可操作)", () => {
    expect(
      audioReferenceDurationRejection([clip("long", 20_000), clip("short", 500)])?.kind,
    ).toBe("tooShort");
  });

  it("探测不出时长 (null) 的既不算太短、也按 0 计入总和 → 放行给后端兜底", () => {
    expect(audioReferenceDurationRejection([clip("unknown", null)])).toBeNull();
    expect(
      audioReferenceDurationRejection([clip("unknown", null), clip("ok", 15_200)]),
    ).toBeNull();
  });

  it("没有音频引用时不拦", () => {
    expect(audioReferenceDurationRejection([])).toBeNull();
  });
});

describe("formatAudioDurationClips — 提示里的 {{clips}} 走 locale 排版", () => {
  // 用真实的 translation.json 而不是假 t()：这里要守的就是「en 用户别看到中文标点」，
  // 假串测不出来。解析 + {{var}} 插值与 i18next 的默认行为一致（escapeValue: false）。
  const locale = (language: "zh" | "en") => {
    const bundle = JSON.parse(
      readFileSync(`public/locales/${language}/translation.json`, "utf8"),
    );
    return (key: string, vars?: Record<string, string | number>) => {
      const value = key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], bundle);
      if (typeof value !== "string") throw new Error(`missing translation key: ${key}`);
      return value.replace(/{{(\w+)}}/g, (_, name: string) => String(vars?.[name] ?? ""));
    };
  };

  const CLIPS = [
    { label: "sfx.wav", durationMs: 900 },
    { label: "bgm.mp3", durationMs: 1_200 },
  ];

  it("中文用全角括号 + 顿号", () => {
    expect(formatAudioDurationClips(CLIPS, locale("zh"))).toBe(
      "sfx.wav（0.9s）、bgm.mp3（1.2s）",
    );
  });

  it("英文用半角括号 + 逗号，且不漏出任何中文标点", () => {
    const formatted = formatAudioDurationClips(CLIPS, locale("en"));
    expect(formatted).toBe("sfx.wav (0.9s), bgm.mp3 (1.2s)");
    expect(formatted).not.toMatch(/[（）、。：]/);
  });

  it("单条时不带分隔符", () => {
    expect(formatAudioDurationClips([CLIPS[0]], locale("en"))).toBe("sfx.wav (0.9s)");
  });

  it("缺文件名时的兜底标签也跟随语言（不再硬编码「音频N」）", () => {
    expect(locale("zh")("node.videoNode.audio.clipFallbackLabel", { index: 2 })).toBe(
      "音频2",
    );
    expect(locale("en")("node.videoNode.audio.clipFallbackLabel", { index: 2 })).toBe(
      "Audio 2",
    );
  });
});

describe("videoModeRequiresPrompt — submit validation by mode", () => {
  it("文生 / 全能参考必须带提示词", () => {
    expect(videoModeRequiresPrompt("textToVideo")).toBe(true);
    expect(videoModeRequiresPrompt("allReference")).toBe(true);
  });

  it("首帧 / 图片参考 / 首尾帧 / 视频编辑允许空提示词", () => {
    for (const mode of [
      "imageToVideo",
      "imageReference",
      "firstLastFrame",
      "videoEdit",
    ] as VideoGenMode[]) {
      expect(videoModeRequiresPrompt(mode)).toBe(false);
    }
  });
});
