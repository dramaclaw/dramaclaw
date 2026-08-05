// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { VIDEO_REFERENCE_ENVELOPE } from "@/features/canvas/domain/videoReferenceLimits";

function incomingEdges(target: string) {
  return useCanvasStore.getState().edges.filter((edge) => edge.target === target);
}

describe("canvasStore 建边入口的素材上限", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  // onConnect 只覆盖手动拖线。资产库选参考、外部文件导入(spawnExternalAssetNodes)
  // 走的是 addEdge —— 它同样是「往一个已存在的视频节点上接素材」，漏掉就等于这条
  // 上限只在拖线时成立，正常产品入口能直接绕过去。
  it("addEdge 也受上限约束：满 9 张图后第 10 张连不上", () => {
    const store = useCanvasStore.getState();
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 900, y: 0 }, {});
    const images = Array.from({ length: VIDEO_REFERENCE_ENVELOPE.image + 1 }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.imageGen, { x: index * 100, y: 0 }, {}),
    );

    for (const image of images.slice(0, VIDEO_REFERENCE_ENVELOPE.image)) {
      expect(useCanvasStore.getState().addEdge(image, video)).not.toBeNull();
    }
    expect(incomingEdges(video)).toHaveLength(VIDEO_REFERENCE_ENVELOPE.image);

    const overflow = images[VIDEO_REFERENCE_ENVELOPE.image];
    expect(useCanvasStore.getState().addEdge(overflow, video)).toBeNull();
    expect(incomingEdges(video)).toHaveLength(VIDEO_REFERENCE_ENVELOPE.image);
  });

  // 外部文件导入的顺序是「先建空 Upload 并连边、再按 MIME 转成 video/audio」。
  // 建边那一刻空 Upload 只能按图片计数，4 个视频文件因此全落在图片上限(9)内 ——
  // 等转换完成就变成 4 条视频引用，超出视频上限(3)。所以类型确定之后必须重算。
  it("Upload 转成视频后超出视频上限的那条边被清掉", () => {
    const store = useCanvasStore.getState();
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 900, y: 0 }, {});
    const uploads = Array.from({ length: VIDEO_REFERENCE_ENVELOPE.video + 1 }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.upload, { x: index * 100, y: 0 }, {}),
    );
    for (const upload of uploads) {
      expect(useCanvasStore.getState().addEdge(upload, video)).not.toBeNull();
    }
    expect(incomingEdges(video)).toHaveLength(VIDEO_REFERENCE_ENVELOPE.video + 1);

    uploads.forEach((upload, index) => {
      useCanvasStore
        .getState()
        .convertNodeType(upload, CANVAS_NODE_TYPES.video, { videoUrl: `/v-${index}.mp4` });
    });

    expect(incomingEdges(video)).toHaveLength(VIDEO_REFERENCE_ENVELOPE.video);
    // 先来的留下、后来的被清掉，用户看到的是「最后那个没接上」而不是随机少一个。
    expect(incomingEdges(video).map((edge) => edge.source)).toEqual(
      uploads.slice(0, VIDEO_REFERENCE_ENVELOPE.video),
    );
  });

  it("没超上限时转换不误伤任何边", () => {
    const store = useCanvasStore.getState();
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 900, y: 0 }, {});
    const uploads = Array.from({ length: VIDEO_REFERENCE_ENVELOPE.video }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.upload, { x: index * 100, y: 0 }, {}),
    );
    for (const upload of uploads) {
      useCanvasStore.getState().addEdge(upload, video);
    }

    uploads.forEach((upload, index) => {
      useCanvasStore
        .getState()
        .convertNodeType(upload, CANVAS_NODE_TYPES.video, { videoUrl: `/v-${index}.mp4` });
    });

    expect(incomingEdges(video)).toHaveLength(VIDEO_REFERENCE_ENVELOPE.video);
  });
});
