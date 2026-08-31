// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isScriptNode,
  isStoryboardGenNode,
  isTextAnnotationNode,
  isUploadNode,
  isVideoNode,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
} from '../domain/canvasNodes';
import type { GraphContentResolver, UpstreamContent } from './ports';

/**
 * 通用的「下游节点 → 上游节点内容」遍历器。一跳深度，按 edges 找出所有
 * `edge.target === selfId` 的源节点，把每种节点已知的内容字段抽到统一的
 * {@link UpstreamContent} shape。
 *
 * 为什么只走一跳：UI 的语义是「我连了谁，我就拿谁的输出」。多跳会让数据
 * 来源变得不可解释，需要时再加 recursive 选项。
 */
export class DefaultGraphContentResolver implements GraphContentResolver {
  collectInputContents(
    nodeId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[]
  ): UpstreamContent[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const sourceIds = edges
      .filter((edge) => edge.target === nodeId)
      .map((edge) => edge.source);

    return sourceIds
      .map((sourceId) => nodeById.get(sourceId))
      .filter((node): node is CanvasNode => node !== undefined)
      .map((node) => extractUpstreamContent(node));
  }
}

/**
 * Pure projection of a single node into its {@link UpstreamContent}. Exported so
 * the per-node subscription hook (`useUpstreamContents`) can map a shallow-
 * selected slice of upstream nodes without re-walking the whole graph.
 */
export function extractUpstreamContent(node: CanvasNode): UpstreamContent {
  const displayNameRaw = (node.data as { displayName?: unknown } | undefined)?.displayName;
  const base: UpstreamContent = {
    nodeId: node.id,
    nodeType: node.type as CanvasNodeType,
    displayName:
      typeof displayNameRaw === 'string' && displayNameRaw.length > 0
        ? displayNameRaw
        : undefined,
  };

  if (isTextAnnotationNode(node)) {
    return { ...base, text: nonEmpty(node.data.content) };
  }
  if (isUploadNode(node)) {
    // 上传节点不一定装的是图：早期版本从资产库选入的视频就是 upload 节点，地址写在
    // data.videoUrl（口径同 VideoNode.referenceVideoUrl）。所以先看 videoUrl —— 这类
    // 节点身上常常同时挂着 previewImageUrl（海报），只看图片字段会把一段视频当成
    // 图片派给下游：图片节点会把它当参考图收下，「素材引用」里又找不到它。
    const rawVideoUrl = (node.data as { videoUrl?: unknown }).videoUrl;
    const videoUrl = typeof rawVideoUrl === 'string' ? nonEmpty(rawVideoUrl) : undefined;
    if (videoUrl) return { ...base, videoUrl };
    return {
      ...base,
      imageUrl:
        nonEmpty(node.data.imageUrl) ?? nonEmpty(node.data.previewImageUrl ?? undefined),
    };
  }
  if (isExportImageNode(node)) {
    return {
      ...base,
      imageUrl:
        nonEmpty(node.data.imageUrl) ?? nonEmpty(node.data.previewImageUrl ?? undefined),
    };
  }
  if (isImageEditNode(node) || isImageGenNode(node)) {
    // 下游消费要看「这个节点眼下展示的是哪张图」：优先生成结果 imageUrl，
    // 退到 previewImageUrl / referenceImageUrl，覆盖未生成只挂参考图的情况。
    //
    // 不携带 `text`：图片节点的 prompt 是「生成这张图的指令」，不是要传给
    // 下游的文本内容。下游引用图片节点时只应拿到这张图（图生图语义），
    // 否则上游 prompt 会被混进下游 prompt（既污染输入框 chip，也污染提交）。
    const referenceImageUrl = isImageGenNode(node)
      ? nonEmpty(node.data.referenceImageUrl ?? undefined)
      : undefined;
    return {
      ...base,
      imageUrl:
        nonEmpty(node.data.imageUrl)
        ?? nonEmpty(node.data.previewImageUrl ?? undefined)
        ?? referenceImageUrl,
    };
  }
  if (isStoryboardGenNode(node)) {
    return {
      ...base,
      imageUrl:
        nonEmpty(node.data.imageUrl) ?? nonEmpty(node.data.previewImageUrl ?? undefined),
    };
  }
  if (isVideoNode(node)) {
    // 同图片节点：视频节点的 prompt 是它自己的生成指令，下游引用视频节点
    // 只拿视频本身（videoUrl），不把上游 prompt 带进下游。
    return {
      ...base,
      videoUrl: nonEmpty(node.data.videoUrl),
    };
  }
  if (isAudioNode(node)) {
    return { ...base, audioUrl: nonEmpty(node.data.audioUrl) };
  }
  if (isScriptNode(node)) {
    const promptRaw = (node.data as { prompt?: unknown }).prompt;
    return {
      ...base,
      text: typeof promptRaw === 'string' ? nonEmpty(promptRaw) : undefined,
    };
  }
  return base;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > 0 ? value : undefined;
}

/**
 * 把上游所有 `text` 字段拼成单段 prompt 上下文，按出现顺序，空段过滤。
 * 调用方一般会把它前置到自己的 prompt 之前再发请求。
 */
export function joinUpstreamText(contents: UpstreamContent[]): string {
  return contents
    .map((content) => (typeof content.text === 'string' ? content.text.trim() : ''))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/**
 * 收集所有上游节点可作为「素材引用」的 URL — 图片和视频。
 * 后端 `reference_urls` 接受同一个数组里混合 image / video。
 * audio 不收（生图节点用不到）。
 *
 * 返回顺序：先所有 imageUrl，再所有 videoUrl，按上游节点连接顺序；
 * 自带去重，避免同一 URL 被多个 resolver 重复送进去。
 */
export function collectUpstreamReferenceUrls(contents: UpstreamContent[]): string[] {
  const out: string[] = [];
  for (const content of contents) {
    if (typeof content.imageUrl === 'string' && content.imageUrl.length > 0) {
      out.push(content.imageUrl);
    }
  }
  for (const content of contents) {
    if (typeof content.videoUrl === 'string' && content.videoUrl.length > 0) {
      out.push(content.videoUrl);
    }
  }
  return Array.from(new Set(out));
}
