// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isStoryboardGenNode,
  isUploadNode,
  isVideoNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

/**
 * 视频节点的**素材连线上限**——建边时就拦，而不是等到提交才报错。
 *
 * 这里卡的是「任何模型 / 任何模式都消费不了」的硬顶，不是当前模式那一格：
 * 首帧只吃 1 张图、首尾帧只吃 2 张，但接上第 2 / 第 3 张图时 VideoNode 的 effect
 * 会自动把模式切到全能参考 / 图片参考；同理连音频到 Seedance 1.x 会自动把模型换成
 * 2.0。按当前模式那格拦，等于把这些自动救场全部拦死 —— 用户连不上第二张图，也就
 * 永远触发不了「首帧 → 全能参考」的自动切换。
 *
 * 所以口径取**能力包络**：图 9 / 视频 3 / 音频 3 / 总数 12，与后端 omni-gen 的
 * `validate_omni_reference_limits`（src/novelvideo/freezone/video_node.py:522）
 * 逐项一致。越过这条线不存在任何可切换的模式或模型能消费，拦掉才是帮用户。
 *
 * 表里更小的那些数字（首帧 1 / 首尾帧 2 / 视频编辑 5 张参考图）继续由「自动切模式」
 * 和提交守卫负责，不在建边这层拦。
 *
 * 9/3/3/12 只是**没有媒体目录配置时的默认值**，不是所有模型的硬上限 ——
 * 见 `videoReferenceEnvelopeForModel`。
 */
export const VIDEO_REFERENCE_ENVELOPE = {
  image: 9,
  video: 3,
  audio: 3,
  total: 12,
} as const;

export interface VideoReferenceEnvelope {
  image: number;
  video: number;
  audio: number;
  total: number;
}

/** 媒体目录里与引用上限相关的那几个字段（`ModelOption` 的子集）。 */
export interface VideoReferenceLimitModel {
  referenceImageMax?: number | null;
  referenceVideoMax?: number | null;
  referenceAudioMax?: number | null;
}

/**
 * 所选模型的**有效**包络：媒体目录配置优先，没配才用 9/3/3/12。
 *
 * 与后端 `_catalog_reference_limits`（api/routes/freezone.py:7004）逐条对齐，包括
 * total 的算法：三项里只要有任意一项来自目录，总数就取三项之和；一项都没配才是 12。
 * 不这么算的话，一个目录里配了 image=10 的合法模型会在第 10 张被前端拦掉，请求永远
 * 到不了本来会接受它的后端 —— 上限比后端严等于把管理员配出来的能力吞掉。
 *
 * 只认非负整数，与后端 `type(value) is int and value >= 0` 同一口径：null / 负数 /
 * 小数一律当作没配。
 */
export function videoReferenceEnvelopeForModel(
  model: VideoReferenceLimitModel | null | undefined,
): VideoReferenceEnvelope {
  const fromCatalog = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

  const image = fromCatalog(model?.referenceImageMax);
  const video = fromCatalog(model?.referenceVideoMax);
  const audio = fromCatalog(model?.referenceAudioMax);
  const resolved = {
    image: image ?? VIDEO_REFERENCE_ENVELOPE.image,
    video: video ?? VIDEO_REFERENCE_ENVELOPE.video,
    audio: audio ?? VIDEO_REFERENCE_ENVELOPE.audio,
  };
  const hasCatalogValue = image !== null || video !== null || audio !== null;
  return {
    ...resolved,
    total: hasCatalogValue
      ? resolved.image + resolved.video + resolved.audio
      : VIDEO_REFERENCE_ENVELOPE.total,
  };
}

/**
 * 建边校验拿不到 React 上下文，模型只能由调用方解析后喂进来。默认值保持 9/3/3/12：
 * 传不进模型时（测试、还没加载出目录）行为与改动之前一致。
 */
export type VideoReferenceEnvelopeResolver = (
  videoNode: CanvasNode,
) => VideoReferenceEnvelope;

const DEFAULT_ENVELOPE_RESOLVER: VideoReferenceEnvelopeResolver = () => ({
  ...VIDEO_REFERENCE_ENVELOPE,
});

export type VideoReferenceMediaKind = 'image' | 'video' | 'audio';

/**
 * 把一个上游节点归类成图片 / 视频 / 音频素材，非素材节点（文本、脚本…）返回 null。
 *
 * 与 VideoNode 里 `upstreamTypeCounts` 同一口径：**按节点类型算，空节点也算**
 * （先连节点后填素材是正常顺序）。唯一的例外是 `data.videoUrl` 优先——资产库选入
 * 的视频是 upload 节点，只看类型会被误当图片。
 */
export function classifyVideoReferenceMedia(
  node: CanvasNode | null | undefined,
): VideoReferenceMediaKind | null {
  if (!node) return null;
  const videoUrl = (node.data as { videoUrl?: unknown }).videoUrl;
  if (isVideoNode(node) || (typeof videoUrl === 'string' && videoUrl.length > 0)) {
    return 'video';
  }
  if (isAudioNode(node)) return 'audio';
  if (
    isImageGenNode(node) ||
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    return 'image';
  }
  return null;
}

const KIND_LABEL: Record<VideoReferenceMediaKind, string> = {
  image: '张图片',
  video: '个视频',
  audio: '个音频',
};

/**
 * 这条连线会不会把视频节点的素材撑过能力包络？返回非空理由则应拒绝建边。
 *
 * 所有建边路径共用（手动拖线的 `isValidConnection` 让落点变灰、store 的 `onConnect`
 * 兜底其余路径），口径必须同源：只在一处拦会表现成「拖过去高亮成合法、一松手什么
 * 也没有」。
 *
 * 目标不是视频节点、源不是素材节点、或源已经连着了（重复连线）一律放行。
 */
export function videoReferenceConnectionRejection(
  nodes: readonly CanvasNode[],
  edges: readonly { source: string; target: string }[],
  connection: { source?: string | null; target?: string | null },
  resolveEnvelope: VideoReferenceEnvelopeResolver = DEFAULT_ENVELOPE_RESOLVER,
): string | null {
  const { source, target } = connection;
  if (!source || !target) return null;
  const targetNode = nodes.find((node) => node.id === target);
  if (!isVideoNode(targetNode)) return null;
  const envelope = resolveEnvelope(targetNode);
  const incoming = classifyVideoReferenceMedia(
    nodes.find((node) => node.id === source),
  );
  if (!incoming) return null;

  const counted = new Set<string>();
  const counts = { image: 0, video: 0, audio: 0 };
  for (const edge of edges) {
    if (edge.target !== target) continue;
    // 同一个源重复连线不叠加计数；它本来也建不出第二条边。
    if (edge.source === source) return null;
    if (counted.has(edge.source)) continue;
    counted.add(edge.source);
    const kind = classifyVideoReferenceMedia(
      nodes.find((node) => node.id === edge.source),
    );
    if (kind) counts[kind] += 1;
  }

  if (counts[incoming] + 1 > envelope[incoming]) {
    return `视频节点最多引用 ${envelope[incoming]} ${KIND_LABEL[incoming]}`;
  }
  const total = counts.image + counts.video + counts.audio;
  if (total + 1 > envelope.total) {
    return `视频节点最多引用 ${envelope.total} 个素材`;
  }
  return null;
}

/**
 * 某个视频节点当前**已经**超出包络的入边（返回要清掉的边 id）。
 *
 * 建边时校验挡不住类型后变的情况：外部文件导入是「先建空 Upload 并连边、再按 MIME
 * 转成 video/audio 节点」，连边那一刻空 Upload 只能按图片计数，4 个视频文件因此全落
 * 在图片上限(9)以内 —— 等转换完成就成了 4 条视频引用，超出视频上限(3)。所以
 * `convertNodeType` 这类会改变素材类型的操作之后必须拿这个函数重算一遍。
 *
 * 保留策略是**先来后到**：按边的插入顺序装桶，装不下的才算溢出。刚转换完的那条边是
 * 最新的，于是被清掉的就是它 —— 用户看到的是「最后拖进来的那个没接上」，而不是
 * 随机少一条老连线。
 */
export function overflowingVideoReferenceEdgeIds(
  nodes: readonly CanvasNode[],
  edges: readonly { id: string; source: string; target: string }[],
  videoTargetId: string,
  resolveEnvelope: VideoReferenceEnvelopeResolver = DEFAULT_ENVELOPE_RESOLVER,
): string[] {
  const targetNode = nodes.find((node) => node.id === videoTargetId);
  if (!isVideoNode(targetNode)) return [];
  const envelope = resolveEnvelope(targetNode);

  const counts = { image: 0, video: 0, audio: 0 };
  let total = 0;
  const counted = new Set<string>();
  const overflow: string[] = [];
  for (const edge of edges) {
    if (edge.target !== videoTargetId) continue;
    if (counted.has(edge.source)) continue;
    counted.add(edge.source);
    const kind = classifyVideoReferenceMedia(
      nodes.find((node) => node.id === edge.source),
    );
    if (!kind) continue;
    if (counts[kind] + 1 > envelope[kind] || total + 1 > envelope.total) {
      overflow.push(edge.id);
      continue;
    }
    counts[kind] += 1;
    total += 1;
  }
  return overflow;
}
