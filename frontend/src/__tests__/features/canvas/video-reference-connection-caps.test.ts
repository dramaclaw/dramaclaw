// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import {
  connectionReferenceCaps,
  countReferenceKinds,
  GEN_MODE_TO_CATALOG_MODE,
  referenceCapsForMode,
  referenceConnectionRejectionReason,
  referenceKindOfNode,
  videoModelForNode,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";

function node(type: string, data: Record<string, unknown> = {}): CanvasNode {
  return { id: `n-${type}-${Math.random()}`, type, position: { x: 0, y: 0 }, data } as CanvasNode;
}

const imageNode = () => node(CANVAS_NODE_TYPES.imageGen);
const videoNode = () => node(CANVAS_NODE_TYPES.video);
const audioNode = () => node(CANVAS_NODE_TYPES.audio);

describe("referenceKindOfNode", () => {
  it("按类型区分图片 / 视频 / 音频", () => {
    expect(referenceKindOfNode(imageNode())).toBe("image");
    expect(referenceKindOfNode(videoNode())).toBe("video");
    expect(referenceKindOfNode(audioNode())).toBe("audio");
  });

  it("带 videoUrl 的 upload 节点（资产库视频）算视频而非图片", () => {
    const assetVideo = node(CANVAS_NODE_TYPES.upload, { videoUrl: "https://x/a.mp4" });
    expect(referenceKindOfNode(assetVideo)).toBe("video");
  });

  it("不作为素材的节点返回 null，不参与计数", () => {
    expect(referenceKindOfNode(node(CANVAS_NODE_TYPES.skill))).toBeNull();
    expect(referenceKindOfNode(null)).toBeNull();
    expect(countReferenceKinds([node(CANVAS_NODE_TYPES.skill), imageNode()])).toEqual({
      images: 1,
      videos: 0,
      audios: 0,
    });
  });
});

describe("connectionReferenceCaps", () => {
  it("模型配了 referenceXxxMax 就直接采信", () => {
    expect(
      connectionReferenceCaps({
        referenceImageMax: 4,
        referenceVideoMax: 1,
        referenceAudioMax: 0,
      }),
    ).toEqual({ image: 4, video: 1, audio: 0 });
  });

  it("没配时取各可达模式的逐类型上界，而不是某一个模式的 cap", () => {
    // allReference 给出 video 3 / audio 3，imageReference 与它并列给出 image 9。
    expect(connectionReferenceCaps(null)).toEqual({ image: 9, video: 3, audio: 3 });
  });

  it("supportedModes 会收窄可达模式集合", () => {
    // 只支持首尾帧：图片上界 2，且不接受视频 / 音频。
    expect(
      connectionReferenceCaps({ supportedModes: ["first_last_frame"] }),
    ).toEqual({ image: 2, video: 0, audio: 0 });
  });

  it("部分配置时，未配置的那几类仍走兜底上界", () => {
    expect(connectionReferenceCaps({ referenceVideoMax: 1 })).toEqual({
      image: 9,
      video: 1,
      audio: 3,
    });
  });

  it("可达模式都不在 cap 表里时不施加数量约束", () => {
    expect(connectionReferenceCaps({ supportedModes: ["text_to_video"] })).toBeNull();
  });
});

describe("referenceConnectionRejectionReason", () => {
  const model = { referenceImageMax: 2, referenceVideoMax: 1, referenceAudioMax: 0 };

  it("未达上限时放行", () => {
    expect(
      referenceConnectionRejectionReason(model, { images: 1, videos: 0, audios: 0 }, "image"),
    ).toBeNull();
  });

  it("正好触顶的那一条仍放行，再多一条才拦", () => {
    expect(
      referenceConnectionRejectionReason(model, { images: 1, videos: 0, audios: 0 }, "image"),
    ).toBeNull();
    expect(
      referenceConnectionRejectionReason(model, { images: 2, videos: 0, audios: 0 }, "image"),
    ).toBe("该模型最多支持 2 张图片素材");
  });

  it("上限为 0 时说的是「不支持」而不是「最多支持 0 个」", () => {
    expect(
      referenceConnectionRejectionReason(model, { images: 0, videos: 0, audios: 0 }, "audio"),
    ).toBe("该模型不支持音频素材");
  });

  it("只拦被连的那一类，别的类型触顶不影响", () => {
    expect(
      referenceConnectionRejectionReason(model, { images: 9, videos: 0, audios: 0 }, "video"),
    ).toBeNull();
  });

  it("模型不限制数量时永远放行", () => {
    expect(
      referenceConnectionRejectionReason(
        { supportedModes: ["text_to_video"] },
        { images: 99, videos: 0, audios: 0 },
        "image",
      ),
    ).toBeNull();
  });

  // 回归点：genMode 会随上游素材自动切换（首尾帧连第 3 张图会切到全能参考）。
  // 若按当前模式的 cap 拦，用户连的正是那条本该触发切模式的边，会被误挡。
  it("不按当前模式的 cap 拦：首尾帧下的第 3 张图仍可连", () => {
    expect(referenceCapsForMode(null, "firstLastFrame")).toEqual({
      image: 2,
      video: 0,
      audio: 0,
    });
    expect(
      referenceConnectionRejectionReason(null, { images: 2, videos: 0, audios: 0 }, "image"),
    ).toBeNull();
  });
});

describe("videoModelForNode", () => {
  const models = [{ id: "a" }, { id: "b" }];

  it("按节点上存的 model id 取", () => {
    expect(videoModelForNode({ data: { model: "b" } }, models)).toEqual({ id: "b" });
  });

  it("没存 / 存的模型已下线时落到列表首个 —— 与选择器展示、提交实际所用一致", () => {
    expect(videoModelForNode({ data: {} }, models)).toEqual({ id: "a" });
    expect(videoModelForNode({ data: { model: "gone" } }, models)).toEqual({ id: "a" });
  });
});

describe("GEN_MODE_TO_CATALOG_MODE", () => {
  // 目录里 imageToVideo 叫 first_frame（它本就是单图首帧 i2v）。这张表同时被
  // GenModeSelect 的 tab 过滤和连线上界计算使用，写错会让「tab 可见但连线被拦」。
  it("imageToVideo 映射到 first_frame", () => {
    expect(GEN_MODE_TO_CATALOG_MODE.imageToVideo).toBe("first_frame");
  });

  it("覆盖全部 genMode", () => {
    expect(Object.keys(GEN_MODE_TO_CATALOG_MODE).sort()).toEqual(
      [
        "allReference",
        "firstLastFrame",
        "imageReference",
        "imageToVideo",
        "textToVideo",
        "videoEdit",
      ].sort(),
    );
  });
});
