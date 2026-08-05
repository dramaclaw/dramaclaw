// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";
import {
  VIDEO_REFERENCE_ENVELOPE,
  classifyVideoReferenceMedia,
  overflowingVideoReferenceEdgeIds,
  videoReferenceConnectionRejection,
  videoReferenceEnvelopeForModel,
} from "@/features/canvas/domain/videoReferenceLimits";
import { videoReferenceEnvelopeForNode } from "@/features/canvas/application/videoReferenceEnvelope";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";

function node(
  id: string,
  type: CanvasNodeType,
  data: Record<string, unknown> = {},
): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as CanvasNode;
}

/** 目标视频节点 + n 个已连上的某类素材节点，返回 (nodes, edges) 供守卫查。 */
function scene(kinds: readonly CanvasNodeType[], datas: readonly Record<string, unknown>[] = []) {
  const target = node("video-target", CANVAS_NODE_TYPES.video);
  const sources = kinds.map((type, index) => node(`src-${index}`, type, datas[index] ?? {}));
  return {
    nodes: [target, ...sources],
    edges: sources.map((source) => ({ source: source.id, target: target.id })),
  };
}

function fill(type: CanvasNodeType, count: number): CanvasNodeType[] {
  return Array.from({ length: count }, () => type);
}

describe("classifyVideoReferenceMedia — 素材归类", () => {
  it("按节点类型归类，空节点也算（先连节点后填素材是正常顺序）", () => {
    expect(classifyVideoReferenceMedia(node("a", CANVAS_NODE_TYPES.imageGen))).toBe("image");
    expect(classifyVideoReferenceMedia(node("a", CANVAS_NODE_TYPES.upload))).toBe("image");
    expect(classifyVideoReferenceMedia(node("a", CANVAS_NODE_TYPES.video))).toBe("video");
    expect(classifyVideoReferenceMedia(node("a", CANVAS_NODE_TYPES.audio))).toBe("audio");
  });

  // 资产库选入的视频是 upload 节点，地址写在 data.videoUrl —— 只看类型会被误当图片。
  it("带 videoUrl 的 upload 节点算视频，不算图片", () => {
    expect(
      classifyVideoReferenceMedia(
        node("a", CANVAS_NODE_TYPES.upload, { videoUrl: "/a.mp4" }),
      ),
    ).toBe("video");
  });

  it("非素材节点（文本 / 空）不计数", () => {
    expect(classifyVideoReferenceMedia(node("a", CANVAS_NODE_TYPES.textAnnotation))).toBeNull();
    expect(classifyVideoReferenceMedia(null)).toBeNull();
  });
});

// 9/3/3/12 只是「目录没配」时的默认值。媒体目录允许把 referenceImageMax 等配成任意
// 非负整数，后端 _catalog_reference_limits（api/routes/freezone.py:7004）会采用它们；
// 前端要是把默认值当硬上限，一个配了 image=10 的合法模型会在第 10 张被拦掉，请求永远
// 到不了本来会接受它的后端 —— 前端比后端严 = 把管理员配出来的能力吞掉。
describe("videoReferenceEnvelopeForModel — 目录配置优先", () => {
  it("没配任何目录值时用默认包络", () => {
    expect(videoReferenceEnvelopeForModel(undefined)).toEqual(VIDEO_REFERENCE_ENVELOPE);
    expect(videoReferenceEnvelopeForModel({})).toEqual(VIDEO_REFERENCE_ENVELOPE);
  });

  // total 的算法与后端 omni 调用点（freezone.py:7857-7868）一致：三项里只要有任意
  // 一项来自目录，总数就取三项之和；一项都没配才回落到 12。
  it("配了任意一项就按三项之和算总数", () => {
    expect(videoReferenceEnvelopeForModel({ referenceImageMax: 10 })).toEqual({
      image: 10,
      video: VIDEO_REFERENCE_ENVELOPE.video,
      audio: VIDEO_REFERENCE_ENVELOPE.audio,
      total: 10 + VIDEO_REFERENCE_ENVELOPE.video + VIDEO_REFERENCE_ENVELOPE.audio,
    });
    expect(
      videoReferenceEnvelopeForModel({
        referenceImageMax: 4,
        referenceVideoMax: 1,
        referenceAudioMax: 0,
      }),
    ).toEqual({ image: 4, video: 1, audio: 0, total: 5 });
  });

  // 与后端 `type(value) is int and value >= 0` 同一口径。
  it("null / 负数 / 小数一律当作没配", () => {
    expect(
      videoReferenceEnvelopeForModel({
        referenceImageMax: null,
        referenceVideoMax: -1,
        referenceAudioMax: 2.5,
      }),
    ).toEqual(VIDEO_REFERENCE_ENVELOPE);
  });
});

describe("videoReferenceEnvelopeForNode — 从节点解析出所选模型的包络", () => {
  const catalog: ModelOption[] = [
    { id: 'first', providerId: 'seedance', apiModel: 'first', label: 'First' },
    {
      id: 'wide',
      providerId: 'seedance',
      apiModel: 'wide',
      label: 'Wide',
      referenceImageMax: 10,
    },
  ];

  it("按 data.model 在目录里查", () => {
    const videoNode = node("v", CANVAS_NODE_TYPES.video, { model: 'wide' });
    expect(videoReferenceEnvelopeForNode(videoNode, catalog).image).toBe(10);
  });

  // 兜底必须和 VideoNode 的 selectedVideoModel 一致（没存 model 时显示列表第一个），
  // 否则会出现「界面按 A 模型显示上限、建边按 B 模型拦」。
  it("没存 model / 目录里查不到时回落到列表第一个", () => {
    expect(videoReferenceEnvelopeForNode(node("v", CANVAS_NODE_TYPES.video), catalog).image).toBe(
      VIDEO_REFERENCE_ENVELOPE.image,
    );
    expect(
      videoReferenceEnvelopeForNode(
        node("v", CANVAS_NODE_TYPES.video, { model: 'gone' }),
        catalog,
      ).image,
    ).toBe(VIDEO_REFERENCE_ENVELOPE.image);
  });

  it("目录还没加载出来（空列表）时退回默认包络", () => {
    expect(videoReferenceEnvelopeForNode(node("v", CANVAS_NODE_TYPES.video), [])).toEqual(
      VIDEO_REFERENCE_ENVELOPE,
    );
  });
});

describe("videoReferenceConnectionRejection — 建边时的素材上限", () => {
  const connect = (nodes: CanvasNode[], edges: { source: string; target: string }[], sourceId: string) =>
    videoReferenceConnectionRejection(nodes, edges, {
      source: sourceId,
      target: "video-target",
    });

  it(`图片满 ${VIDEO_REFERENCE_ENVELOPE.image} 张后拒绝第 ${VIDEO_REFERENCE_ENVELOPE.image + 1} 张`, () => {
    const { nodes, edges } = scene(fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image));
    const extra = node("extra", CANVAS_NODE_TYPES.imageGen);
    expect(connect([...nodes, extra], edges, extra.id)).toContain(
      String(VIDEO_REFERENCE_ENVELOPE.image),
    );
  });

  it("没满就放行", () => {
    const { nodes, edges } = scene(
      fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image - 1),
    );
    const extra = node("extra", CANVAS_NODE_TYPES.imageGen);
    expect(connect([...nodes, extra], edges, extra.id)).toBeNull();
  });

  // 这是「按能力包络拦」而不是「按当前模式那格拦」的核心用例：首帧只吃 1 张图，
  // 但第 2 张必须连得上，否则 VideoNode 里「首帧 → 全能参考」的自动切换永远
  // 触发不了，用户会被卡在单图状态。
  it("首帧模式下第 2 张图仍放行 —— 留给自动切模式去纠正", () => {
    const { nodes, edges } = scene([CANVAS_NODE_TYPES.imageGen]);
    const second = node("second", CANVAS_NODE_TYPES.imageGen);
    expect(connect([...nodes, second], edges, second.id)).toBeNull();
  });

  it(`视频 / 音频各自满 ${VIDEO_REFERENCE_ENVELOPE.video} 个后拒绝`, () => {
    for (const [type, cap] of [
      [CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video],
      [CANVAS_NODE_TYPES.audio, VIDEO_REFERENCE_ENVELOPE.audio],
    ] as const) {
      const { nodes, edges } = scene(fill(type, cap));
      const extra = node("extra", type);
      expect(connect([...nodes, extra], edges, extra.id)).toContain(String(cap));
    }
  });

  // 后端 validate_omni_reference_limits 除了逐项还有 total_max=12：图 9 + 视频 3
  // 已经顶满总数，再连音频逐项没超、总数超了。
  it("逐项都没超但总数超 12 → 也拒绝", () => {
    const { nodes, edges } = scene([
      ...fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image),
      ...fill(CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video),
    ]);
    const extra = node("extra", CANVAS_NODE_TYPES.audio);
    expect(connect([...nodes, extra], edges, extra.id)).toContain(
      String(VIDEO_REFERENCE_ENVELOPE.total),
    );
  });

  it("目标不是视频节点 / 源不是素材节点 → 不管", () => {
    const { nodes, edges } = scene(fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image));
    const text = node("text", CANVAS_NODE_TYPES.textAnnotation);
    // 满 9 张图，但连进来的是文本节点：不占素材位。
    expect(connect([...nodes, text], edges, text.id)).toBeNull();
    // 同样 9 张图，目标换成图片节点：这条上限只管视频节点。
    const imageTarget = node("image-target", CANVAS_NODE_TYPES.imageGen);
    const extra = node("extra", CANVAS_NODE_TYPES.imageGen);
    expect(
      videoReferenceConnectionRejection(
        [...nodes, imageTarget, extra],
        edges.map((edge) => ({ ...edge, target: imageTarget.id })),
        { source: extra.id, target: imageTarget.id },
      ),
    ).toBeNull();
  });

  // 重连一条已存在的边不该被自己挡住（它本来也建不出第二条边）。
  it("同一个源重复连线放行", () => {
    const { nodes, edges } = scene(fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image));
    expect(connect(nodes, edges, "src-0")).toBeNull();
  });

  // 包络由调用方解析后喂进来：目录里配了 image=10 的模型，第 10 张必须放行。
  it("按模型包络放行 —— 目录配 image=10 时第 10 张连得上", () => {
    const { nodes, edges } = scene(fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image));
    const extra = node("extra", CANVAS_NODE_TYPES.imageGen);
    expect(
      videoReferenceConnectionRejection(
        [...nodes, extra],
        edges,
        { source: extra.id, target: "video-target" },
        () => videoReferenceEnvelopeForModel({ referenceImageMax: 10 }),
      ),
    ).toBeNull();
  });

  it("上游是带 videoUrl 的 upload 节点时按视频计数，不占图片额度", () => {
    const { nodes, edges } = scene(
      fill(CANVAS_NODE_TYPES.upload, VIDEO_REFERENCE_ENVELOPE.video),
      Array.from({ length: VIDEO_REFERENCE_ENVELOPE.video }, () => ({ videoUrl: "/a.mp4" })),
    );
    const extraVideo = node("extra-video", CANVAS_NODE_TYPES.video);
    expect(connect([...nodes, extraVideo], edges, extraVideo.id)).toContain(
      String(VIDEO_REFERENCE_ENVELOPE.video),
    );
    // 同样这批 upload 节点没占图片额度，图片还能继续连。
    const extraImage = node("extra-image", CANVAS_NODE_TYPES.imageGen);
    expect(connect([...nodes, extraImage], edges, extraImage.id)).toBeNull();
  });
});

// 建边时的校验挡不住「先连边、后变类型」：外部文件导入先落空 Upload 并连边（按图片
// 计数），再按 MIME 转成 video/audio。类型定下来之后必须能重算出溢出的那几条。
describe("overflowingVideoReferenceEdgeIds — 类型变了之后的重算", () => {
  function graph(kinds: readonly CanvasNodeType[]) {
    const target = node("video-target", CANVAS_NODE_TYPES.video);
    const sources = kinds.map((type, index) => node(`src-${index}`, type));
    return {
      nodes: [target, ...sources],
      edges: sources.map((source) => ({
        id: `e-${source.id}`,
        source: source.id,
        target: target.id,
      })),
    };
  }

  it("没超时返回空", () => {
    const { nodes, edges } = graph(fill(CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video));
    expect(overflowingVideoReferenceEdgeIds(nodes, edges, "video-target")).toEqual([]);
  });

  it("超出的按先来后到只溢出最后几条", () => {
    const { nodes, edges } = graph(
      fill(CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video + 2),
    );
    expect(overflowingVideoReferenceEdgeIds(nodes, edges, "video-target")).toEqual([
      `e-src-${VIDEO_REFERENCE_ENVELOPE.video}`,
      `e-src-${VIDEO_REFERENCE_ENVELOPE.video + 1}`,
    ]);
  });

  it("逐项没超但总数超 12 时也算溢出", () => {
    const { nodes, edges } = graph([
      ...fill(CANVAS_NODE_TYPES.imageGen, VIDEO_REFERENCE_ENVELOPE.image),
      ...fill(CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video),
      CANVAS_NODE_TYPES.audio,
    ]);
    expect(overflowingVideoReferenceEdgeIds(nodes, edges, "video-target")).toEqual([
      `e-src-${VIDEO_REFERENCE_ENVELOPE.total}`,
    ]);
  });

  // 重算同样按模型包络走：目录配了 video=5 的模型，5 条视频引用一条都不该被清掉。
  it("按模型包络重算 —— 目录配 video=5 时 5 条视频都留下", () => {
    const { nodes, edges } = graph(fill(CANVAS_NODE_TYPES.video, 5));
    expect(
      overflowingVideoReferenceEdgeIds(nodes, edges, "video-target", () =>
        videoReferenceEnvelopeForModel({ referenceVideoMax: 5 }),
      ),
    ).toEqual([]);
  });

  it("目标不是视频节点时不管", () => {
    const { nodes, edges } = graph(fill(CANVAS_NODE_TYPES.video, VIDEO_REFERENCE_ENVELOPE.video + 2));
    const imageTarget = node("image-target", CANVAS_NODE_TYPES.imageGen);
    expect(
      overflowingVideoReferenceEdgeIds(
        [...nodes, imageTarget],
        edges.map((edge) => ({ ...edge, target: imageTarget.id })),
        imageTarget.id,
      ),
    ).toEqual([]);
  });
});
