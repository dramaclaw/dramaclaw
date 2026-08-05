// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { VIDEO_REFERENCE_ENVELOPE } from "@/features/canvas/domain/videoReferenceLimits";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";

// 建边校验跑在 React 之外，模型目录从 useFreezoneVideoModels 的 module-level store 读。
// 这里替掉那个读取口就能喂进任意目录；默认空列表 = 目录还没加载，行为回落到默认包络，
// 下面前几个用例仍按 9/3/3/12 断言。
let catalog: ModelOption[] = [];
vi.mock("@/features/canvas/hooks/useFreezoneVideoModels", () => ({
  readFreezoneVideoModels: () => catalog,
  prefetchFreezoneVideoModels: () => {},
  useFreezoneVideoModels: () => ({
    models: catalog,
    isLoading: false,
    isFallback: true,
    error: null,
  }),
}));

function incomingEdges(target: string) {
  return useCanvasStore.getState().edges.filter((edge) => edge.target === target);
}

describe("canvasStore 建边入口的素材上限", () => {
  beforeEach(() => {
    catalog = [];
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

  // 媒体目录允许把 referenceImageMax 配成任意非负整数，后端会照配置放行。前端要是把
  // 默认的 9 当成所有模型的硬上限，配了 image=10 的模型在第 10 张就被本地拦掉，请求永远
  // 到不了本来会接受它的后端。建边校验必须按**所选模型**的有效包络走。
  it("目录配了 image=10 的模型：第 10 张图连得上", () => {
    catalog = [
      {
        id: "wide-model",
        providerId: "seedance",
        apiModel: "wide-model",
        label: "Wide",
        referenceImageMax: 10,
      },
    ];
    const store = useCanvasStore.getState();
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 900, y: 0 }, { model: "wide-model" });
    const images = Array.from({ length: 10 }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.imageGen, { x: index * 100, y: 0 }, {}),
    );
    for (const image of images) {
      expect(useCanvasStore.getState().addEdge(image, video)).not.toBeNull();
    }
    expect(incomingEdges(video)).toHaveLength(10);
  });

  // 反过来也要成立：目录把上限配得比默认更小时，前端不能放行到 9。
  it("目录配了 image=2 的模型：第 3 张图就拦住", () => {
    catalog = [
      {
        id: "narrow-model",
        providerId: "seedance",
        apiModel: "narrow-model",
        label: "Narrow",
        referenceImageMax: 2,
      },
    ];
    const store = useCanvasStore.getState();
    const video = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 900, y: 0 },
      { model: "narrow-model" },
    );
    const images = Array.from({ length: 3 }, (_, index) =>
      useCanvasStore
        .getState()
        .addNode(CANVAS_NODE_TYPES.imageGen, { x: index * 100, y: 0 }, {}),
    );
    expect(useCanvasStore.getState().addEdge(images[0], video)).not.toBeNull();
    expect(useCanvasStore.getState().addEdge(images[1], video)).not.toBeNull();
    expect(useCanvasStore.getState().addEdge(images[2], video)).toBeNull();
    expect(incomingEdges(video)).toHaveLength(2);
  });

  // 类型转换后的重算走的是同一把尺子：目录配 video=5 时，5 条视频引用一条都不该被清掉。
  it("目录配了 video=5 的模型：Upload 全转成视频后 5 条边都留下", () => {
    catalog = [
      {
        id: "many-video",
        providerId: "seedance",
        apiModel: "many-video",
        label: "ManyVideo",
        referenceVideoMax: 5,
      },
    ];
    const store = useCanvasStore.getState();
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 900, y: 0 }, { model: "many-video" });
    const uploads = Array.from({ length: 5 }, (_, index) =>
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

    expect(incomingEdges(video)).toHaveLength(5);
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
