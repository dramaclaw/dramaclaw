// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { videoModeDisabledReason } from "@/features/canvas/nodes/VideoOperationsPanel";

const NONE = { videos: 0, images: 0, audios: 0 };

/** 目录里声明了 video_edit 的非 HappyHorse 模型（seedance-2.0-mini / 2.5 这一类）。 */
const WITH_VIDEO_EDIT = [
  "text_to_video",
  "first_frame",
  "first_last_frame",
  "all_reference",
  "image_reference",
  "video_edit",
];
/** 没有 video_edit 的 Seedance 2.0。 */
const WITHOUT_VIDEO_EDIT = [
  "text_to_video",
  "first_frame",
  "first_last_frame",
  "all_reference",
  "image_reference",
];

describe("videoModeDisabledReason — 上游接了视频时的模式可用性", () => {
  /**
   * 回归：接了 1 个视频后「视频编辑」被置灰，hover 写着「上游含视频素材时只能用
   * 「全能参考」」。那条规则写在视频编辑还是 HappyHorse 专属的年代，后来目录里的
   * 模型也声明了 video_edit，tab 露出来却被同一条规则连坐。
   */
  it("接 1 个视频时「视频编辑」可选（模型声明了 video_edit）", () => {
    expect(
      videoModeDisabledReason(
        "videoEdit",
        "seedance-2.0-mini",
        { ...NONE, videos: 1 },
        WITH_VIDEO_EDIT,
      ),
    ).toBeNull();
  });

  it("接了视频时其余模式仍被拦，且提示里带上「视频编辑」这条出路", () => {
    for (const mode of ["textToVideo", "firstFrame", "firstLastFrame", "imageReference"] as const) {
      expect(
        videoModeDisabledReason(mode, "seedance-2.0-mini", { ...NONE, videos: 1 }, WITH_VIDEO_EDIT),
      ).toBe("上游含视频素材时只能用「全能参考」或「视频编辑」");
    }
    expect(
      videoModeDisabledReason(
        "allReference",
        "seedance-2.0-mini",
        { ...NONE, videos: 1 },
        WITH_VIDEO_EDIT,
      ),
    ).toBeNull();
  });

  it("模型没有 video_edit 时提示不提这条出路", () => {
    expect(
      videoModeDisabledReason(
        "textToVideo",
        "seedance-2.0",
        { ...NONE, videos: 1 },
        WITHOUT_VIDEO_EDIT,
      ),
    ).toBe("上游含视频素材时只能用「全能参考」");
  });

  it("没接视频时「视频编辑」提示去连一个", () => {
    expect(
      videoModeDisabledReason("videoEdit", "seedance-2.0-mini", NONE, WITH_VIDEO_EDIT),
    ).toBe("需要连接视频节点（1个）");
  });

  it("接了多个视频时「视频编辑」不可用", () => {
    expect(
      videoModeDisabledReason(
        "videoEdit",
        "seedance-2.0-mini",
        { ...NONE, videos: 2 },
        WITH_VIDEO_EDIT,
      ),
    ).toBe("「视频编辑」仅支持连接 1 个视频节点");
  });

  it("模型不支持视频编辑时说清楚是模型的事，不是上游的事", () => {
    expect(
      videoModeDisabledReason(
        "videoEdit",
        "seedance-2.0",
        { ...NONE, videos: 1 },
        WITHOUT_VIDEO_EDIT,
      ),
    ).toBe("该模型不支持「视频编辑」");
  });

  /** HappyHorse 走它自己那套分支，这次改动不能动到它。 */
  it("HappyHorse 的既有判定不受影响", () => {
    expect(videoModeDisabledReason("videoEdit", "happyhorse-1.0", { ...NONE, videos: 1 })).toBeNull();
    expect(videoModeDisabledReason("videoEdit", "happyhorse-1.0", NONE)).toBe(
      "需要连接视频节点（1个）",
    );
    expect(videoModeDisabledReason("textToVideo", "happyhorse-1.0", { ...NONE, videos: 1 })).toBe(
      "已连接视频节点，请使用「视频编辑」",
    );
  });
});
