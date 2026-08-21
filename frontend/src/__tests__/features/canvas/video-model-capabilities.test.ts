// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { VideoGenMode } from "@/features/canvas/domain/canvasNodes";
import {
  audioReferenceDurationRejection,
  audioReferenceTotalDurationLimitMs,
  formatAudioDurationClips,
  MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS,
  GEN_MODE_TO_CATALOG_MODE,
  isGrokVideoChannelModel,
  isHappyHorseVideoModel,
  isSeedance1xVideoModel,
  isSeedance2VideoModel,
  isVideoModeSupportedByModel,
  referenceDurationLimitsMs,
  resolveVideoKeyframeUrls,
  videoEmptyStateCtaModes,
  videoModeForcesAutomaticAspectRatio,
  videoModeRequiresMedia,
  videoModeRequiresPrompt,
  videoModelDefaultGenerateAudio,
  videoModelSupportsGenerateAudio,
  videoModelReferenceDisabledReason,
  videoMultiImageAutoSwitchMode,
  videoNoUpstreamResetMode,
  videoReferenceAutoSwitchAction,
  type VideoReferenceAutoSwitchAction,
  videoSubmitMediaRejectionReason,
  videoUpstreamImageDefaultMode,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";

describe("视频模式有效比例", () => {
  it.each([
    ["firstFrame", true],
    ["firstLastFrame", true],
    ["videoEdit", true],
    ["textToVideo", false],
    ["imageToVideo", false],
    ["imageReference", false],
    ["allReference", false],
  ] as const)("%s 是否强制跟随输入素材", (mode, expected) => {
    expect(videoModeForcesAutomaticAspectRatio(mode)).toBe(expected);
  });
});

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

describe("video native audio capability", () => {
  it("preserves legacy support and default when catalog fields are absent", () => {
    expect(videoModelSupportsGenerateAudio(SEEDANCE2_FAST)).toBe(true);
    expect(videoModelDefaultGenerateAudio({ apiModel: SEEDANCE2_FAST })).toBe(true);
  });

  it("defaults native audio on whenever the model supports it", () => {
    expect(videoModelSupportsGenerateAudio({ supportsGenerateAudio: true })).toBe(true);
    expect(
      videoModelDefaultGenerateAudio({
        supportsGenerateAudio: true,
      }),
    ).toBe(true);
    expect(
      videoModelDefaultGenerateAudio({
        supportsGenerateAudio: false,
      }),
    ).toBe(false);
  });
});

describe("videoEmptyStateCtaModes — CTA by model capability", () => {
  it("Seedance 2.0 → 全能参考 / 图生视频 / 首帧 / 图片参考 / 首尾帧", () => {
    expect(videoEmptyStateCtaModes(SEEDANCE2_FAST)).toEqual([
      "allReference",
      "imageToVideo",
      "firstFrame",
      "imageReference",
      "firstLastFrame",
    ]);
  });

  it("Seedance 1.x → 只给「首帧」(全能参考会 400、首尾帧尾帧被静默丢弃、多图不支持)", () => {
    for (const id of [SEEDANCE10_PRO_FAST, SEEDANCE15_PRO]) {
      const cta = videoEmptyStateCtaModes(id);
      expect(cta).toEqual(["firstFrame"]);
      // 回归护栏：1.x 空态绝不出现只有 2.0 支持的入口。
      expect(cta).not.toContain("allReference");
      expect(cta).not.toContain("firstLastFrame");
    }
  });

  it("HappyHorse → 图生视频 / 首帧 / 图片参考 (无全能参考 / 首尾帧)", () => {
    const cta = videoEmptyStateCtaModes(HAPPYHORSE);
    expect(cta).toEqual(["imageToVideo", "firstFrame", "imageReference"]);
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

describe("目录 supportedModes 是模式入口的单一事实来源", () => {
  const firstFrameOnly = {
    apiModel: SEEDANCE15_PRO,
    supportedModes: ["text_to_video", "first_frame"],
  };
  const imageReferenceOnly = {
    apiModel: "custom-reference-model",
    supportedModes: ["text_to_video", "image_reference"],
  };
  const imageToVideoOnly = {
    apiModel: "custom-image-to-video-model",
    supportedModes: ["text_to_video", "image_to_video"],
  };
  const comfyAllReference = {
    apiModel: "minimax_h3_r2v",
    supportedModes: ["text_to_video", "image_reference", "all_reference"],
  };

  it("只声明 first_frame 的模型仍有真正首帧入口，不会误进图生视频", () => {
    expect(isVideoModeSupportedByModel("firstFrame", firstFrameOnly)).toBe(true);
    expect(isVideoModeSupportedByModel("imageToVideo", firstFrameOnly)).toBe(false);
    expect(videoEmptyStateCtaModes(firstFrameOnly)).toEqual(["firstFrame"]);
    expect(videoUpstreamImageDefaultMode(firstFrameOnly)).toBe("firstFrame");
  });

  it("图生视频和图片参考由两个独立目录能力控制", () => {
    expect(isVideoModeSupportedByModel("firstFrame", imageReferenceOnly)).toBe(false);
    expect(isVideoModeSupportedByModel("imageToVideo", imageReferenceOnly)).toBe(false);
    expect(isVideoModeSupportedByModel("imageReference", imageReferenceOnly)).toBe(true);
    expect(videoEmptyStateCtaModes(imageReferenceOnly)).toEqual(["imageReference"]);
    expect(videoUpstreamImageDefaultMode(imageReferenceOnly)).toBe("imageReference");

    expect(isVideoModeSupportedByModel("imageToVideo", imageToVideoOnly)).toBe(true);
    expect(isVideoModeSupportedByModel("imageReference", imageToVideoOnly)).toBe(false);
    expect(videoEmptyStateCtaModes(imageToVideoOnly)).toEqual(["imageToVideo"]);
    expect(videoUpstreamImageDefaultMode(imageToVideoOnly)).toBe("imageToVideo");
  });

  it("前端模式到目录能力的映射区分首帧和图片参考", () => {
    expect(GEN_MODE_TO_CATALOG_MODE.firstFrame).toBe("first_frame");
    expect(GEN_MODE_TO_CATALOG_MODE.imageToVideo).toBe("image_to_video");
    expect(GEN_MODE_TO_CATALOG_MODE.imageReference).toBe("image_reference");
  });

  it("非 Seedance 模型声明 all_reference 后可使用多图、视频和音频素材", () => {
    expect(isVideoModeSupportedByModel("allReference", comfyAllReference)).toBe(true);
    expect(videoUpstreamImageDefaultMode(comfyAllReference)).toBe("allReference");
    expect(videoMultiImageAutoSwitchMode("imageToVideo", comfyAllReference, 2)).toBe(
      "allReference",
    );
    expect(
      videoModelReferenceDisabledReason(comfyAllReference, {
        images: 9,
        videos: 3,
        audios: 3,
      }),
    ).toBeNull();
    expect(
      videoSubmitMediaRejectionReason("allReference", comfyAllReference, {
        images: 9,
        videos: 3,
        audios: 3,
      }),
    ).toBeNull();
  });
});

describe("isVideoModeSupportedByModel — mode gating by model", () => {
  const commonModes: VideoGenMode[] = ["textToVideo", "firstFrame"];

  it("全能参考 / 首尾帧仅 Seedance 2.0", () => {
    for (const mode of ["allReference", "firstLastFrame"] as VideoGenMode[]) {
      expect(isVideoModeSupportedByModel(mode, SEEDANCE2_FAST)).toBe(true);
      expect(isVideoModeSupportedByModel(mode, SEEDANCE10_PRO_FAST)).toBe(false);
      expect(isVideoModeSupportedByModel(mode, SEEDANCE15_PRO)).toBe(false);
      expect(isVideoModeSupportedByModel(mode, HAPPYHORSE)).toBe(false);
    }
  });

  it("文生 / 首帧所有视频模型都支持", () => {
    for (const id of [SEEDANCE2_FAST, SEEDANCE10_PRO_FAST, HAPPYHORSE]) {
      for (const mode of commonModes) {
        expect(isVideoModeSupportedByModel(mode, id)).toBe(true);
      }
    }
  });

  it("Seedance 1.x 不把图片参考伪装成首帧", () => {
    for (const mode of ["imageToVideo", "imageReference"] as VideoGenMode[]) {
      expect(isVideoModeSupportedByModel(mode, SEEDANCE10_PRO_FAST)).toBe(false);
      expect(isVideoModeSupportedByModel(mode, SEEDANCE15_PRO)).toBe(false);
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
    expect(videoUpstreamImageDefaultMode(SEEDANCE10_PRO_FAST)).toBe("firstFrame");
    expect(videoUpstreamImageDefaultMode(SEEDANCE15_PRO)).toBe("firstFrame");
  });
});

describe("resolveVideoKeyframeUrls — stable edge slots", () => {
  it("稳定槽位优先于可编辑标题，重命名尾帧不会被提升成首帧", () => {
    expect(
      resolveVideoKeyframeUrls([
        { url: "last.png", slot: "last", legacyDisplayName: "结尾画面" },
      ]),
    ).toEqual({ firstFrameUrl: null, lastFrameUrl: "last.png" });
  });

  it("旧画布没有槽位时兼容历史标题，再按连线顺序补位", () => {
    expect(
      resolveVideoKeyframeUrls([
        { url: "legacy-last.png", legacyDisplayName: "尾帧" },
        { url: "unassigned.png", legacyDisplayName: "上传图片" },
      ]),
    ).toEqual({ firstFrameUrl: "unassigned.png", lastFrameUrl: "legacy-last.png" });
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

  it("目录显式开放音频后，视频编辑消费独立音频", () => {
    const audioVideoEditModel = {
      apiModel: "custom-video-editor",
      supportedModes: ["video_edit"],
      referenceAudioMax: 2,
    };
    expect(
      videoSubmitMediaRejectionReason("videoEdit", audioVideoEditModel, {
        images: 0,
        videos: 1,
        audios: 1,
      }),
    ).toBeNull();
    expect(
      videoSubmitMediaRejectionReason(
        "videoEdit",
        { ...audioVideoEditModel, referenceAudioMax: 0 },
        { images: 0, videos: 1, audios: 1 },
      ),
    ).toBeTruthy();
  });
});

describe("videoMultiImageAutoSwitchMode — 首帧接多图时的自动改模式", () => {
  // 这条是 bug 本体：i2v 端点按图片张数分流（1 张 = 图生视频，2-9 张 = 图片参考），
  // 接上第二张图后做的其实已经是图片参考了，界面上模式却还写着「首帧生成视频」。
  it("Seedance 2.0：首帧接到第 2 张图 → 切全能参考", () => {
    expect(videoMultiImageAutoSwitchMode("imageToVideo", SEEDANCE2_FAST, 2)).toBe(
      "allReference",
    );
    expect(videoMultiImageAutoSwitchMode("imageToVideo", SEEDANCE2_VALUE, 9)).toBe(
      "allReference",
    );
  });

  it("单图 / 无图不动 —— 那正是首帧本来的用法", () => {
    for (const images of [0, 1]) {
      expect(
        videoMultiImageAutoSwitchMode("imageToVideo", SEEDANCE2_FAST, images),
      ).toBeNull();
    }
  });

  it("只管首帧模式，其它模式一律不插手", () => {
    for (const mode of [
      "textToVideo",
      "imageReference",
      "allReference",
      "firstLastFrame",
      "videoEdit",
    ] as VideoGenMode[]) {
      expect(videoMultiImageAutoSwitchMode(mode, SEEDANCE2_FAST, 5)).toBeNull();
    }
  });

  // HappyHorse 自己那套状态机（videos>0→视频编辑 / images>1→图片参考）已经收口了，
  // 这里再插一脚只会两处 updateNodeData 来回打架。
  it("HappyHorse 不动，交给它自己的状态机", () => {
    expect(videoMultiImageAutoSwitchMode("imageToVideo", HAPPYHORSE, 3)).toBeNull();
  });

  // 换模式救不了 1.x：它的 i2v 端点 >1 图直接 400，切到哪个模式都是 400。留在首帧上，
  // 让提交守卫那句「该模型单次仅支持 1 张图片」把「该换模型」这个真问题说清楚。
  it("Seedance 1.x 不动：它多图必 400，问题在模型不在模式", () => {
    for (const id of [SEEDANCE10_PRO_FAST, SEEDANCE15_PRO]) {
      expect(videoMultiImageAutoSwitchMode("imageToVideo", id, 2)).toBeNull();
      expect(videoSubmitMediaRejectionReason("imageToVideo", id, {
        images: 2,
        videos: 0,
        audios: 0,
      })).toBeTruthy();
    }
  });

  // 媒体目录声明的 supportedModes 优先级高于启发式（与可见 tab 同一口径）。
  it("目录声明没有全能参考时退到图片参考；两个都没有则不动", () => {
    expect(
      videoMultiImageAutoSwitchMode(
        "imageToVideo",
        {
          id: SEEDANCE2_FAST,
          apiModel: SEEDANCE2_FAST,
          supportedModes: ["text_to_video", "first_frame", "image_reference"],
        },
        2,
      ),
    ).toBe("imageReference");
    expect(
      videoMultiImageAutoSwitchMode(
        "imageToVideo",
        {
          id: SEEDANCE2_FAST,
          apiModel: SEEDANCE2_FAST,
          supportedModes: ["text_to_video", "first_frame"],
        },
        2,
      ),
    ).toBeNull();
  });

  // 自动改模式与提交守卫必须闭合：切完之后那个模式得真能提交，否则等于把用户从
  // 一个坑挪到另一个坑。
  it("切过去的模式在提交守卫里放行", () => {
    const counts = { images: 3, videos: 0, audios: 0 };
    const target = videoMultiImageAutoSwitchMode("imageToVideo", SEEDANCE2_FAST, counts.images);
    expect(target).not.toBeNull();
    expect(
      videoSubmitMediaRejectionReason(target as VideoGenMode, SEEDANCE2_FAST, counts),
    ).toBeNull();
  });

  // 自动切模式只是把界面导对，真正兜底提交的是引用上限：万一模式没被切走（比如
  // effect 还没跑、或将来又有人加了 bail 条件），提交也只能带 1 张图，绝不能靠
  // 张数悄悄变成图片参考。这条上限是结构性的，不接受媒体目录 referenceImageMax 覆盖。
  it("首帧和单图图生视频的图片上限锁死在 1，且不被媒体目录配置覆盖", () => {
    const source = readFileSync("src/features/canvas/nodes/VideoNode.tsx", "utf8");
    expect(source).toContain("firstFrame: { image: 1, video: 0, audio: 0 }");
    expect(source).toContain("imageToVideo: { image: 1, video: 0, audio: 0 }");
    expect(source).toContain("const FIXED_IMAGE_CAP_BY_MODE");
    expect(source).toContain(
      "image: FIXED_IMAGE_CAP_BY_MODE[mode] ?? model?.referenceImageMax ?? defaults.image",
    );
  });
});

describe("HappyHorse 单图默认模式", () => {
  it("默认进入图生视频，首帧仍是目录声明后的独立可选模式", () => {
    const configured = {
      apiModel: HAPPYHORSE,
      supportedModes: [
        "text_to_video",
        "first_frame",
        "image_to_video",
        "image_reference",
        "video_edit",
      ],
    };
    expect(videoUpstreamImageDefaultMode(configured)).toBe("imageToVideo");
    expect(isVideoModeSupportedByModel("firstFrame", configured)).toBe(true);
    expect(isVideoModeSupportedByModel("imageToVideo", configured)).toBe(true);
  });

  // 默认值必须真的可用，否则一连图就顶进一个 hover 提示写着「不可用」的 tab。
  it("图片参考在 1~9 张图时都可用", () => {
    const source = readFileSync(
      "src/features/canvas/nodes/VideoOperationsPanel.tsx",
      "utf8",
    );
    expect(source).toContain('if (images === 0) return "需要连接图片节点（1~9个）";');
    expect(source).toContain('if (images > 9) return "「图片参考」最多支持 9 张图片";');
  });
});

describe("videoModelReferenceDisabledReason — 模型选择器置灰守卫", () => {
  const none = { images: 0, videos: 0, audios: 0 };

  // 回归：曾经写成 `counts.images > 0` 一律置灰，一张图片节点就把整个 Seedance 1 系列
  // 锁死 —— 而单图首帧恰恰是 1.x 唯一能用的模式，后端也只在 >1 图时才 400。
  it("Seedance 1.x：单图 → 可选（不置灰）", () => {
    for (const id of [SEEDANCE10_PRO_FAST, SEEDANCE15_PRO]) {
      expect(videoModelReferenceDisabledReason(id, { ...none, images: 1 })).toBeNull();
      expect(videoModelReferenceDisabledReason(id, none)).toBeNull();
    }
  });

  it("Seedance 1.x：>1 图 → 置灰", () => {
    expect(
      videoModelReferenceDisabledReason(SEEDANCE15_PRO, { ...none, images: 2 }),
    ).toBeTruthy();
  });

  it("Seedance 1.x：接入视频 / 音频 → 置灰", () => {
    expect(
      videoModelReferenceDisabledReason(SEEDANCE10_PRO_FAST, { ...none, videos: 1 }),
    ).toBeTruthy();
    expect(
      videoModelReferenceDisabledReason(SEEDANCE10_PRO_FAST, { ...none, audios: 1 }),
    ).toBeTruthy();
  });

  // 两条守卫是一对，阈值漂开就会出现「能选但一提交就被拦」或反过来的自相矛盾。
  it("与提交守卫同阈值：单图放行 / 多图拦截的判定一致", () => {
    for (const images of [0, 1, 2, 9]) {
      const counts = { ...none, images };
      const pickerBlocked = videoModelReferenceDisabledReason(SEEDANCE15_PRO, counts) != null;
      const submitBlocked =
        videoSubmitMediaRejectionReason("imageToVideo", SEEDANCE15_PRO, counts) != null;
      expect(pickerBlocked).toBe(submitBlocked);
    }
  });

  it("Seedance 2.0：多图 + 视频 + 音频都不置灰（全能参考全吃）", () => {
    for (const id of [SEEDANCE2_FAST, SEEDANCE2_VALUE]) {
      expect(
        videoModelReferenceDisabledReason(id, { images: 9, videos: 1, audios: 1 }),
      ).toBeNull();
    }
  });

  it("HappyHorse：多图 / 视频不置灰（r2v 与视频编辑各有路径），音频置灰", () => {
    expect(
      videoModelReferenceDisabledReason(HAPPYHORSE, { images: 9, videos: 1, audios: 0 }),
    ).toBeNull();
    // 音频只有全能参考(2.0)能消费，而 HappyHorse 永远到不了 allReference —— 不拦
    // 就会把用户放进「选得进去、提交必被拦」的死胡同。
    expect(
      videoModelReferenceDisabledReason(HAPPYHORSE, { ...none, audios: 1 }),
    ).toBeTruthy();
  });

  it("目录声明 video_edit 且音频上限大于 0 时，带音频仍可选择模型", () => {
    expect(
      videoModelReferenceDisabledReason(
        {
          apiModel: "custom-video-editor",
          supportedModes: ["video_edit"],
          referenceAudioMax: 1,
        },
        { ...none, videos: 1, audios: 1 },
      ),
    ).toBeNull();
  });

  // 后台把某个模型的「视频编辑」下掉后，启发式那套「HappyHorse 天生能吃视频」的假设
  // 就不成立了 —— 目录声明才是事实。
  it("HappyHorse：目录里没有 video_edit 时，接入视频 → 置灰", () => {
    const withoutVideoEdit = {
      apiModel: HAPPYHORSE,
      supportedModes: [
        "text_to_video",
        "first_frame",
        "image_reference",
        "first_last_frame",
      ],
    };
    expect(
      videoModelReferenceDisabledReason(withoutVideoEdit, { ...none, videos: 1 }),
    ).toBe("该模型不支持视频素材");
    // 目录里还留着 video_edit 的话照旧放行，别把整个模型误伤掉。
    expect(
      videoModelReferenceDisabledReason(
        { apiModel: HAPPYHORSE, supportedModes: [...withoutVideoEdit.supportedModes, "video_edit"] },
        { ...none, videos: 1 },
      ),
    ).toBeNull();
  });

  // 回归：选择器曾把模型塌成 `model.apiModel ?? model.id` 再传进来，目录声明的
  // supportedModes 在这条路径上整个丢掉，只剩启发式 —— 后台下掉 HappyHorse 的视频
  // 编辑后，它在选择器里依然可选，用户选进去后所有模式都是灰的、提交也被拦，成了
  // 死胡同。这里锁住「传整个 ModelOption」，与 VideoNode 的提交守卫同源。
  it("模型选择器必须把整个 ModelOption 传给置灰守卫（而非只传 id）", () => {
    const source = readFileSync(
      "src/features/canvas/nodes/VideoOperationsPanel.tsx",
      "utf8",
    );
    expect(source).toContain("videoModelReferenceDisabledReason(model, {");
    expect(source).not.toContain(
      "videoModelReferenceDisabledReason(model.apiModel ?? model.id",
    );
  });

  it("Grok Video Channel：仅图片、且最多 8 张", () => {
    const GROK = "newapi_grok-video-channel";
    expect(videoModelReferenceDisabledReason(GROK, { ...none, images: 8 })).toBeNull();
    expect(videoModelReferenceDisabledReason(GROK, { ...none, images: 9 })).toBeTruthy();
    expect(videoModelReferenceDisabledReason(GROK, { ...none, videos: 1 })).toBeTruthy();
    expect(videoModelReferenceDisabledReason(GROK, { ...none, audios: 1 })).toBeTruthy();
  });
});

// 两条守卫真正要维持的不变量——不是逐条阈值相等（HappyHorse 的多图/视频由它自己的
// 路径消化，两边判断本就不同），而是「选得进去就必须走得通」。这条网格测试就是当年
// 「HappyHorse + 音频」那类死胡同的探照灯：选择器放行、却没有任何一个它支持的模式能
// 通过提交守卫。Grok 不在网格里：后端 FREEZONE_DISABLED_VIDEO_BACKENDS 把它关掉了，
// 压根不会出现在选择器中，它那条分支是休眠的。
describe("置灰守卫 × 提交守卫 — 不置灰的组合必须存在可提交的模式", () => {
  const ALL_MODES: VideoGenMode[] = [
    "textToVideo",
    "firstFrame",
    "imageToVideo",
    "imageReference",
    "allReference",
    "firstLastFrame",
    "videoEdit",
  ];
  const PICKER_MODELS = [
    SEEDANCE10_PRO_FAST,
    SEEDANCE15_PRO,
    SEEDANCE2_FAST,
    SEEDANCE2_VALUE,
    HAPPYHORSE,
  ];

  it("对每个模型 × 每种素材组合都成立", () => {
    const deadEnds: string[] = [];
    for (const modelId of PICKER_MODELS) {
      for (const images of [0, 1, 2, 9]) {
        for (const videos of [0, 1]) {
          for (const audios of [0, 1]) {
            const counts = { images, videos, audios };
            if (videoModelReferenceDisabledReason(modelId, counts) != null) {
              continue; // 已置灰 —— 用户选不进来，谈不上死胡同
            }
            const usable = ALL_MODES.some(
              (mode) =>
                isVideoModeSupportedByModel(mode, modelId) &&
                videoSubmitMediaRejectionReason(mode, modelId, counts) == null,
            );
            if (!usable) {
              deadEnds.push(`${modelId} + ${JSON.stringify(counts)}`);
            }
          }
        }
      }
    }
    expect(deadEnds).toEqual([]);
  });
});

// 选择器的真实顺序：Fast 排在基础款 2.0 前面（见 ProviderModelPicker VIDEO_MODELS）。
// 这个顺序是关键——挑目标不能图省事取「第一个 2.0」，那会落到 Fast 上。
const SEEDANCE2_BASE = "newapi_seedance-2.0";
const MODELS = [
  { id: SEEDANCE2_FAST, apiModel: SEEDANCE2_FAST },
  { id: SEEDANCE2_BASE, apiModel: SEEDANCE2_BASE },
  { id: SEEDANCE2_VALUE, apiModel: SEEDANCE2_VALUE },
  { id: SEEDANCE15_PRO, apiModel: SEEDANCE15_PRO },
  { id: SEEDANCE10_PRO_FAST, apiModel: SEEDANCE10_PRO_FAST },
];

function expectSwitch(action: VideoReferenceAutoSwitchAction) {
  if (action.kind !== "switch") {
    throw new Error(`期望 switch，实际拿到 ${action.kind}`);
  }
  return action;
}

describe("videoReferenceAutoSwitchAction — 接入视频/音频时替 1.x 换成 2.0", () => {
  // 常态入参：列表已就绪、还没落闩。加载时序与闩锁本身在下一个 describe 里按帧验。
  const pick = (
    currentModelId: string | null | undefined,
    counts: { videos: number; audios: number },
    models: readonly { id: string; apiModel?: string }[],
  ) =>
    videoReferenceAutoSwitchAction({
      counts,
      currentModelId,
      models,
      modelsLoading: false,
      alreadySwitched: false,
    });

  it("Seedance 1.x + 视频 → 换成基础款 2.0（不是排在前面的 Fast），并落到全能参考", () => {
    expect(pick(SEEDANCE10_PRO_FAST, { videos: 1, audios: 0 }, MODELS)).toEqual({
      kind: "switch",
      modelId: SEEDANCE2_BASE,
      genMode: "allReference",
    });
  });

  it("Seedance 1.x + 音频 → 同样切到基础款 2.0", () => {
    expect(pick(SEEDANCE15_PRO, { videos: 0, audios: 1 }, MODELS)).toEqual({
      kind: "switch",
      modelId: SEEDANCE2_BASE,
      genMode: "allReference",
    });
  });

  it("候选里没有基础款（只下发了 fast / value 变体）→ 退到任意一个 2.0", () => {
    const action = pick(SEEDANCE10_PRO_FAST, { videos: 1, audios: 0 }, [
      { id: SEEDANCE2_VALUE, apiModel: SEEDANCE2_VALUE },
      { id: SEEDANCE2_FAST, apiModel: SEEDANCE2_FAST },
    ]);
    expect(expectSwitch(action).modelId).toBe(SEEDANCE2_VALUE);
  });

  it("素材没接 / 已撤走 → release（松闩），不写任何 patch", () => {
    expect(pick(SEEDANCE10_PRO_FAST, { videos: 0, audios: 0 }, MODELS)).toEqual({
      kind: "release",
    });
  });

  it("返回的是 id 而非 apiModel —— 存进 VideoNodeData.model 的是 id", () => {
    const renamed = [{ id: "picker-id-2.0", apiModel: "newapi_seedance-2.0" }];
    const action = pick(SEEDANCE15_PRO, { videos: 1, audios: 0 }, renamed);
    expect(expectSwitch(action).modelId).toBe("picker-id-2.0");
  });

  it("2.0 / HappyHorse / Grok 都不抢：各有自己的路径或渠道", () => {
    for (const id of [SEEDANCE2_FAST, HAPPYHORSE, "newapi_grok-video-channel"]) {
      expect(pick(id, { videos: 1, audios: 1 }, MODELS)).toEqual({ kind: "none" });
    }
  });

  it("候选列表里没有 2.0（接口异常）→ 宁可不动也不瞎切", () => {
    expect(
      pick(SEEDANCE10_PRO_FAST, { videos: 1, audios: 0 }, [
        { id: SEEDANCE15_PRO, apiModel: SEEDANCE15_PRO },
      ]),
    ).toEqual({ kind: "none" });
    expect(pick(SEEDANCE10_PRO_FAST, { videos: 1, audios: 0 }, [])).toEqual({ kind: "none" });
  });

  // 切完必须自洽：新模型 + 新模式既不该被选择器置灰，也不该被提交守卫拦下，
  // 否则就是把用户从一个死胡同推进另一个。
  it("切换结果自洽：目标模型在同样的素材下既不置灰也不被提交守卫拦", () => {
    const counts = { images: 1, videos: 1, audios: 1 };
    const next = expectSwitch(pick(SEEDANCE10_PRO_FAST, counts, MODELS));
    expect(videoModelReferenceDisabledReason(next.modelId, counts)).toBeNull();
    expect(videoSubmitMediaRejectionReason(next.genMode, next.modelId, counts)).toBeNull();
    expect(isVideoModeSupportedByModel(next.genMode, next.modelId)).toBe(true);
  });
});

// useFreezoneVideoModels 在 pending 期间返回的**不是空数组**，而是硬编码的
// VIDEO_MODELS（isLoading: true / isFallback: true）。所以「列表非空」根本不能当作
// 「列表已就绪」用——照着 fallback 挑出来的 2.0 未必存在于该项目的真列表里，提前切了
// 还落闩，真列表回来也不再纠正，节点就卡在一个后端不认识的模型上。下面按帧回放组件那
// 条 effect，专门盯这段时序。
describe("videoReferenceAutoSwitchAction — 模型列表异步加载期间的闸门", () => {
  // 加载中先给出的硬编码 fallback：里面有 2.0。
  const FALLBACK_WITH_2 = MODELS;
  // 该项目真列表：接口只下发了 1.x，没有任何 2.0。
  const REAL_ONLY_1X = [
    { id: SEEDANCE15_PRO, apiModel: SEEDANCE15_PRO },
    { id: SEEDANCE10_PRO_FAST, apiModel: SEEDANCE10_PRO_FAST },
  ];
  // 该项目真列表：模型 id 与硬编码那份不同名，但确实有基础款 2.0。
  const REAL_WITH_2 = [
    { id: "proj-2.0-fast", apiModel: SEEDANCE2_FAST },
    { id: "proj-2.0", apiModel: SEEDANCE2_BASE },
  ];

  interface Frame {
    currentModelId: string;
    models: readonly { id: string; apiModel?: string }[];
    modelsLoading: boolean;
    counts?: { videos: number; audios: number };
  }

  /** 原样跑一遍组件里那条 effect 的分支：算 action → 更新闩锁 / 记录写入。 */
  function replay(frames: readonly Frame[]) {
    let latched = false;
    const writes: { modelId: string; genMode: VideoGenMode }[] = [];
    for (const frame of frames) {
      const action = videoReferenceAutoSwitchAction({
        counts: frame.counts ?? { videos: 1, audios: 0 },
        currentModelId: frame.currentModelId,
        models: frame.models,
        modelsLoading: frame.modelsLoading,
        alreadySwitched: latched,
      });
      if (action.kind === "release") {
        latched = false;
      } else if (action.kind === "switch") {
        latched = true;
        writes.push({ modelId: action.modelId, genMode: action.genMode });
      }
    }
    return { writes, latched };
  }

  // 这条是 reviewer 点名要的回归：fallback 里有 2.0，真列表却只有 1.x。
  it("fallback 有 2.0 但真列表只有 1.x → 全程不写，绝不写入列表里不存在的模型", () => {
    const { writes, latched } = replay([
      { currentModelId: SEEDANCE15_PRO, models: FALLBACK_WITH_2, modelsLoading: true },
      { currentModelId: SEEDANCE15_PRO, models: REAL_ONLY_1X, modelsLoading: false },
      { currentModelId: SEEDANCE15_PRO, models: REAL_ONLY_1X, modelsLoading: false },
    ]);
    expect(writes).toEqual([]);
    // 也没落闩：真列表哪天补上 2.0，这次跳变仍然有机会被救。
    expect(latched).toBe(false);
  });

  it("加载中不动；真列表到了才切，且切的是真列表里的 id，只切一次", () => {
    const { writes } = replay([
      { currentModelId: SEEDANCE15_PRO, models: FALLBACK_WITH_2, modelsLoading: true },
      { currentModelId: SEEDANCE15_PRO, models: FALLBACK_WITH_2, modelsLoading: true },
      { currentModelId: SEEDANCE15_PRO, models: REAL_WITH_2, modelsLoading: false },
      // 切完后 selectedVideoModelId 变成新模型，effect 还会再跑几帧。
      { currentModelId: "proj-2.0", models: REAL_WITH_2, modelsLoading: false },
    ]);
    expect(writes).toEqual([{ modelId: "proj-2.0", genMode: "allReference" }]);
  });

  // isFallback 刻意不作为入参：它在「URL 没 project」「拉取失败」「后端返回空列表」
  // 这三种**已落定**的情况下会一直是 true，而此时选择器渲染的就是这份 VIDEO_MODELS，
  // 2.0 就在里面、用户手动也能选。跟着 isFallback 一起挡 = 永久关掉救场。
  it("已落定的 fallback（isLoading 已 false）照常救场，不因为「是 fallback」而放弃", () => {
    const { writes } = replay([
      { currentModelId: SEEDANCE15_PRO, models: FALLBACK_WITH_2, modelsLoading: true },
      { currentModelId: SEEDANCE15_PRO, models: FALLBACK_WITH_2, modelsLoading: false },
    ]);
    expect(writes).toEqual([{ modelId: SEEDANCE2_BASE, genMode: "allReference" }]);
  });

  // 闩锁的意义：undo 把 model 恢复成 1.x、而视频边还在时，不能再纠正回去，
  // 否则 updateNodeData 会再压一条 past 并清空 future，⌘Z 看起来毫无反应。
  it("落闩后即使模型被 undo 回 1.x（素材边仍在）也不再纠正", () => {
    const { writes } = replay([
      { currentModelId: SEEDANCE15_PRO, models: MODELS, modelsLoading: false },
      { currentModelId: SEEDANCE2_BASE, models: MODELS, modelsLoading: false },
      // ⌘Z：model 回到 1.x，视频边还在
      { currentModelId: SEEDANCE15_PRO, models: MODELS, modelsLoading: false },
      { currentModelId: SEEDANCE15_PRO, models: MODELS, modelsLoading: false },
    ]);
    expect(writes).toHaveLength(1);
  });

  it("素材撤走后松闩，下次再接入还能救一次", () => {
    const { writes } = replay([
      { currentModelId: SEEDANCE15_PRO, models: MODELS, modelsLoading: false },
      // 拔线：videos 归零 → release
      {
        currentModelId: SEEDANCE15_PRO,
        models: MODELS,
        modelsLoading: false,
        counts: { videos: 0, audios: 0 },
      },
      // 重新连上
      { currentModelId: SEEDANCE15_PRO, models: MODELS, modelsLoading: false },
    ]);
    expect(writes).toHaveLength(2);
  });

  it("加载中素材就被撤走 → 仍然松闩（松闩只是复位 ref，没必要等列表）", () => {
    const action = videoReferenceAutoSwitchAction({
      counts: { videos: 0, audios: 0 },
      currentModelId: SEEDANCE15_PRO,
      models: FALLBACK_WITH_2,
      modelsLoading: true,
      alreadySwitched: true,
    });
    expect(action).toEqual({ kind: "release" });
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

  it("单条长于 15.2s → 拦，并指名是哪条；15.2s 整放行", () => {
    expect(audioReferenceDurationRejection([clip("a", 15_200)])).toBeNull();
    expect(
      audioReferenceDurationRejection([clip("bgm.mp3", 5_000), clip("long.wav", 15_201)]),
    ).toEqual({
      kind: "tooLong",
      clips: [{ label: "long.wav", durationMs: 15_201 }],
    });
  });

  // 这条曾经断言「3 条 6s 共 18s 厂商也收」。2026-08-06 3060 环境实测打脸：厂商在
  // r2v 另有 `audio total duration ... must be less than or equal to 15.2` 一条，
  // 逐条全合规的 18s 组合照样 400。别把它改回放行。
  it("逐条都合规但总和超限 → 拦，并带上总时长和上限", () => {
    expect(
      audioReferenceDurationRejection([
        clip("a", 6_000),
        clip("b", 6_000),
        clip("c", 6_000),
      ]),
    ).toEqual({
      kind: "totalTooLong",
      clips: [
        { label: "a", durationMs: 6_000 },
        { label: "b", durationMs: 6_000 },
        { label: "c", durationMs: 6_000 },
      ],
      totalMs: 18_000,
      limitMs: 15_200,
    });
  });

  it("总和恰好顶格 15.2s 放行，多 1ms 才拦", () => {
    expect(
      audioReferenceDurationRejection([clip("a", 9_000), clip("b", 6_200)]),
    ).toBeNull();
    expect(
      audioReferenceDurationRejection([clip("a", 9_000), clip("b", 6_201)])?.kind,
    ).toBe("totalTooLong");
  });

  it("单条顶格 15.2s 不会被总和这条误伤 (兜底上限与单条上限同值)", () => {
    expect(audioReferenceDurationRejection([clip("a", 15_200)])).toBeNull();
  });

  it("单条太长优先于总和上报 (先换掉那条，再谈整体裁剪)", () => {
    expect(
      audioReferenceDurationRejection([clip("a", 20_000), clip("b", 6_000)])?.kind,
    ).toBe("tooLong");
  });

  it("总和上限走传入值 (后台 referenceAudioTotalMaxSeconds)", () => {
    const clips = [clip("a", 6_000), clip("b", 6_000)];
    expect(audioReferenceDurationRejection(clips)).toBeNull();
    expect(audioReferenceDurationRejection(clips, { totalLimitMs: 30_000 })).toBeNull();
    expect(audioReferenceDurationRejection(clips, { totalLimitMs: 10_000 })).toEqual({
      kind: "totalTooLong",
      clips: [
        { label: "a", durationMs: 6_000 },
        { label: "b", durationMs: 6_000 },
      ],
      totalMs: 12_000,
      limitMs: 10_000,
    });
  });

  it("perClipLimits: false 只判总和——1.8~15.2 是 seedance2 专属数字，别拿去卡别家", () => {
    // 后台给某个非 seedance2 模型配了 60s 总时长：一条 25s 的音频对它完全合法，
    // 若还套用逐条 15.2s 就是我们凭空 400 掉一次正常提交。
    const options = { totalLimitMs: 60_000, perClipLimits: false };
    expect(audioReferenceDurationRejection([clip("a", 25_000)], options)).toBeNull();
    expect(audioReferenceDurationRejection([clip("a", 500)], options)).toBeNull();
    // 总和这条仍然管着。
    expect(
      audioReferenceDurationRejection([clip("a", 40_000), clip("b", 25_000)], options),
    ).toMatchObject({ kind: "totalTooLong", totalMs: 65_000, limitMs: 60_000 });
  });

  it("测不出的条目不计入总和——和只会偏小，所以判超了必定真超", () => {
    // 3 条各 6s，其中一条测不出：可见部分 12s 未超，放行给后端 ffprobe 兜底。
    expect(
      audioReferenceDurationRejection([
        clip("a", 6_000),
        clip("b", null),
        clip("c", 6_000),
      ]),
    ).toBeNull();
  });

  it("既有太短又有太长时优先报太短 (一次只报一类，别混着列)", () => {
    expect(
      audioReferenceDurationRejection([clip("long", 20_000), clip("short", 500)]),
    ).toEqual({
      kind: "tooShort",
      clips: [{ label: "short", durationMs: 500 }],
    });
  });

  it("同类越界的多条一次全列出来", () => {
    expect(
      audioReferenceDurationRejection([
        clip("a", 900),
        clip("b", 5_000),
        clip("c", 1_000),
      ])?.clips,
    ).toEqual([
      { label: "a", durationMs: 900 },
      { label: "c", durationMs: 1_000 },
    ]);
  });

  it("探测不出时长 (null) 的不参与判定 → 放行给后端兜底", () => {
    expect(audioReferenceDurationRejection([clip("unknown", null)])).toBeNull();
    expect(
      audioReferenceDurationRejection([clip("unknown", null), clip("ok", 15_200)]),
    ).toBeNull();
  });

  it("没有音频引用时不拦", () => {
    expect(audioReferenceDurationRejection([])).toBeNull();
  });

  it("支持后台配置的总时长下限，且存在未探测素材时不误拦", () => {
    expect(
      audioReferenceDurationRejection([clip("a", 4_000), clip("b", 5_000)], {
        minMs: null,
        maxMs: null,
        totalMinMs: 10_000,
        totalLimitMs: null,
        perClipLimits: false,
      }),
    ).toMatchObject({ kind: "totalTooShort", totalMs: 9_000, limitMs: 10_000 });
    expect(
      audioReferenceDurationRejection([clip("a", 4_000), clip("unknown", null)], {
        minMs: null,
        maxMs: null,
        totalMinMs: 10_000,
        totalLimitMs: null,
        perClipLimits: false,
      }),
    ).toBeNull();
  });
});

describe("referenceDurationLimitsMs — 目录时长配置", () => {
  it("分别读取音频和视频的单条/总时长配置", () => {
    const model = {
      referenceAudioMinSeconds: 1.8,
      referenceAudioTotalMaxSeconds: 15.2,
      referenceVideoMaxSeconds: 12,
      referenceVideoTotalMinSeconds: 5,
    };
    expect(referenceDurationLimitsMs(model, "audio")).toEqual({
      minMs: 1_800,
      maxMs: undefined,
      totalMinMs: undefined,
      totalMaxMs: 15_200,
    });
    expect(referenceDurationLimitsMs(model, "video")).toEqual({
      minMs: undefined,
      maxMs: 12_000,
      totalMinMs: 5_000,
      totalMaxMs: undefined,
    });
  });
});

describe("audioReferenceTotalDurationLimitMs — 目录优先、15.2s 兜底", () => {
  it("没配 / 配了非法值 → 兜底 15.2s", () => {
    expect(audioReferenceTotalDurationLimitMs(null)).toBe(15_200);
    expect(audioReferenceTotalDurationLimitMs(undefined)).toBe(15_200);
    expect(audioReferenceTotalDurationLimitMs({})).toBe(15_200);
    for (const bad of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: bad }),
      ).toBe(MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS);
    }
  });

  it("配了就听配置，且**接受小数**——15.2 本身就不是整数", () => {
    expect(
      audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: 30 }),
    ).toBe(30_000);
    expect(
      audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: 15.2 }),
    ).toBe(15_200);
    // 别顺手套 Number.isInteger：那会把管理员配的 12.5s 静默退回 15.2s，比后端更宽。
    expect(
      audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: 12.5 }),
    ).toBe(12_500);
  });

  it("vendorCapMs 与目录值取小——配宽了不能越过厂商硬顶", () => {
    const capped = { vendorCapMs: MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS };
    // 管理员给 seedance2 配 60s：3 条 6s 在本地全过、到厂商那儿照样 400。必须取小。
    expect(
      audioReferenceTotalDurationLimitMs(
        { referenceAudioTotalMaxSeconds: 60 },
        capped,
      ),
    ).toBe(15_200);
    // 收严的方向照收。
    expect(
      audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: 8 }, capped),
    ).toBe(8_000);
    // 没配就是硬顶本身。
    expect(audioReferenceTotalDurationLimitMs(null, capped)).toBe(15_200);
    // 不传 vendorCapMs（边界未知的模型）就没有硬顶可取，60s 照用。
    expect(
      audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: 60 }),
    ).toBe(60_000);
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

  it("紧贴阈值的毫秒不四舍五入到合法值 (否则提示自相矛盾)", () => {
    // 1.799s 曾被显示成「1.8s」、15.201s 曾被显示成「15.2s」——用户看到的正好是
    // 合法边界值，却被告知越界。展示按毫秒精度，别再退回 toFixed(1)。
    expect(
      formatAudioDurationClips([{ label: "a.wav", durationMs: 1_799 }], locale("en")),
    ).toBe("a.wav (1.799s)");
    expect(
      formatAudioDurationClips([{ label: "b.wav", durationMs: 15_201 }], locale("en")),
    ).toBe("b.wav (15.201s)");
  });

  it("整秒不拖尾随 0", () => {
    expect(
      formatAudioDurationClips([{ label: "c.wav", durationMs: 6_000 }], locale("en")),
    ).toBe("c.wav (6s)");
    expect(
      formatAudioDurationClips([{ label: "d.wav", durationMs: 15_200 }], locale("en")),
    ).toBe("d.wav (15.2s)");
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
      "firstFrame",
      "imageToVideo",
      "imageReference",
      "firstLastFrame",
      "videoEdit",
    ] as VideoGenMode[]) {
      expect(videoModeRequiresPrompt(mode)).toBe(false);
    }
  });
});

describe("videoModeRequiresMedia — 该模式是否必须有上游素材", () => {
  it("文生视频是唯一不需要素材的模式", () => {
    expect(videoModeRequiresMedia("textToVideo")).toBe(false);
  });

  it("全能参考同样需要素材（omni 端点没素材就发不出去）", () => {
    // 与 videoModeRequiresPrompt 是**并列**关系而非二选一：全能参考两条都要。
    // 只看提示词的话，素材撤空后按钮仍然可点，点了却被 handleSubmit 的
    // references.length === 0 静默拦下 —— 用户看到的就是「点了没反应」。
    expect(videoModeRequiresMedia("allReference")).toBe(true);
    expect(videoModeRequiresPrompt("allReference")).toBe(true);
  });

  it("其余生成模式都要素材", () => {
    for (const mode of [
      "firstFrame",
      "imageToVideo",
      "imageReference",
      "firstLastFrame",
      "videoEdit",
    ] as VideoGenMode[]) {
      expect(videoModeRequiresMedia(mode)).toBe(true);
    }
  });
});

describe("videoNoUpstreamResetMode — 素材撤空后退回文生视频", () => {
  const EMPTY = { images: 0, videos: 0, audios: 0 };

  it("上游清空后，任何素材模式都退回文生视频", () => {
    for (const mode of [
      "allReference",
      "imageReference",
      "firstFrame",
      "imageToVideo",
      "firstLastFrame",
      "videoEdit",
    ] as VideoGenMode[]) {
      expect(videoNoUpstreamResetMode(mode, EMPTY)).toBe("textToVideo");
    }
  });

  it("已经是文生视频就不动（避免每帧都发一次 patch）", () => {
    expect(videoNoUpstreamResetMode("textToVideo", EMPTY)).toBeNull();
  });

  it.each([
    ["图片", { images: 1, videos: 0, audios: 0 }],
    ["视频", { images: 0, videos: 1, audios: 0 }],
    ["音频", { images: 0, videos: 0, audios: 1 }],
  ] as const)("上游还有%s素材时不动", (_label, counts) => {
    expect(videoNoUpstreamResetMode("allReference", counts)).toBeNull();
  });
});

describe("VideoNode 接线：素材撤空 → 文生视频", () => {
  const source = readFileSync("src/features/canvas/nodes/VideoNode.tsx", "utf8");

  it("反向复位 effect 按节点类型口径判定，不用已解析 URL 口径", () => {
    // upstreamCounts（已解析 URL）会把空态 CTA 刚铺好、还没出图的图片节点算成 0 张，
    // 用它当场就会把三个 CTA 顶回文生视频。
    expect(source).toContain(
      "videoNoUpstreamResetMode(genMode, upstreamTypeCounts)",
    );
  });

  it("复位不进撤销栈", () => {
    // 这是「用户删素材」的衍生结果而非独立改动；记进 past 会让 ⌘Z 被本 effect 立刻
    // 撤销回去、redo 栈还被清空，等于把「回到连线之前」这条路堵死。
    expect(source).toContain(
      "updateNodeData(id, { genMode: target }, { recordHistory: false });",
    );
  });

  it("提交闸门把提示词与素材拆成两条并列判定", () => {
    expect(source).toContain(
      "(videoModeRequiresPrompt(genMode) && !hasPromptText) ||\n      (videoModeRequiresMedia(genMode) && !hasRequiredMediaForMode);",
    );
    // 旧的三元写法：要提示词的模式就不再看素材 —— 全能参考因此漏网。
    expect(source).not.toContain(
      "videoModeRequiresPrompt(genMode)\n        ? !hasPromptText\n        : !hasRequiredMediaForMode",
    );
  });
});
