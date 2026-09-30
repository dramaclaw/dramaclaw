// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  isAudioNode,
  isImageEditNode,
  isImageGenNode,
  isVideoNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { extractUpstreamContent } from '@/features/canvas/application/graphContentResolver';
import {
  referenceImageUrl,
  referenceVideoUrl,
} from '@/features/canvas/nodes/referenceMedia';
import {
  orderedReferenceUrlsWithOwnFirst,
  sortUpstreamByReferenceOrder,
} from '@/features/canvas/nodes/referenceOrdering';

/** 提示词里一个 `@图片1` / `@视频2` / `@音频1` 引用解析出的目标。 */
export interface PromptReferenceTarget {
  /** mention 标签（不含 @），如 "图片1"。 */
  label: string;
  kind: 'image' | 'video' | 'audio';
  /** 缩略图 / 图片本体 url；音频无缩略图时为 null。 */
  thumbnailUrl: string | null;
  /** 对应的上游节点 id；节点自带参考图没有上游节点，为 null。 */
  nodeId: string | null;
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

/**
 * 解析某节点提示词里 `@图片N` / `@视频N` / `@音频N` 各自指向哪个素材。
 *
 * **编号规则完全复用工作流那两份**（自己另写一套会错位）：
 *
 * - 图片生成家族（imageGen 及同族图片节点）：`orderedReferenceUrlsWithOwnFirst(
 *   自身 referenceImageUrl, 上游图片 url 按连线顺序去重)` —— 节点自带参考图占第 1 位，
 *   后端也按这个位置解释 图片N（见 referenceOrdering 的注释与 ImageGenNode
 *   的 mentionCandidates）。**不**过 referenceOrder：ImageGenNode 走的是
 *   useUpstreamContents（纯连线顺序）。
 * - 视频家族（VideoNode）：先 `sortUpstreamByReferenceOrder(上游, data.referenceOrder)`，
 *   再按 *各自类型* 独立计数（图片/视频/音频三条计数器），与 VideoNode 的
 *   referenceMedia → mentionCandidates 一致。注意 VideoNode 里 cap 过滤发生在
 *   序号自增之后，只影响候选可见性、不影响编号，所以这里不需要复制 cap 逻辑。
 *
 * @param node 承载提示词的节点。
 * @param upstreamNodes 该节点的一跳上游，**必须按连线顺序**
 *   （`upstreamNodesInEdgeOrder`），与工作流取数一致。
 * @returns label（不含 @）→ 目标。解析不到的引用不会出现在 map 里，
 *   调用方据此降级为纯文本。
 */
export function resolvePromptReferences(
  node: CanvasNode,
  upstreamNodes: CanvasNode[],
): Map<string, PromptReferenceTarget> {
  const out = new Map<string, PromptReferenceTarget>();
  if (isVideoNode(node)) {
    const ordered = sortUpstreamByReferenceOrder(
      upstreamNodes,
      asRecord(node.data).referenceOrder as string[] | undefined,
    );
    let imageIdx = 0;
    let videoIdx = 0;
    let audioIdx = 0;
    for (const upstream of ordered) {
      const videoUrl = referenceVideoUrl(upstream);
      if (videoUrl) {
        videoIdx += 1;
        const previewImageUrl = asRecord(upstream.data).previewImageUrl;
        out.set(`视频${videoIdx}`, {
          label: `视频${videoIdx}`,
          kind: 'video',
          thumbnailUrl:
            typeof previewImageUrl === 'string' && previewImageUrl.length > 0
              ? previewImageUrl
              : null,
          nodeId: upstream.id,
        });
        continue;
      }
      if (isAudioNode(upstream)) {
        const audioUrl = asRecord(upstream.data).audioUrl;
        if (typeof audioUrl !== 'string' || audioUrl.length === 0) continue;
        audioIdx += 1;
        out.set(`音频${audioIdx}`, {
          label: `音频${audioIdx}`,
          kind: 'audio',
          thumbnailUrl: null,
          nodeId: upstream.id,
        });
        continue;
      }
      const url = referenceImageUrl(upstream);
      if (url) {
        imageIdx += 1;
        out.set(`图片${imageIdx}`, {
          label: `图片${imageIdx}`,
          kind: 'image',
          thumbnailUrl: url,
          nodeId: upstream.id,
        });
      }
    }
    return out;
  }

  // 图片家族：自带参考图排第 1，上游图按连线顺序接在后面（URL 去重）。
  // ImageEditNode 例外：标签是 `图N`（无「片」），编号基线是纯上游图片
  // （useUpstreamImages，见 ImageEditNode 的 useReferenceMentionSync），没有自带参考图这一位。
  const labelPrefix = isImageEditNode(node) ? '图' : '图片';
  const ownReferenceUrl = isImageGenNode(node)
    ? ((): string | null => {
        const raw = asRecord(node.data).referenceImageUrl;
        return typeof raw === 'string' && raw.length > 0 ? raw : null;
      })()
    : null;
  // 与 ImageGenNode 的 upstreamImageContents 同构：按连线顺序取上游 imageUrl 并按 url 去重。
  const upstreamImageEntries: Array<{ url: string; nodeId: string }> = [];
  const seen = new Set<string>();
  for (const upstream of upstreamNodes) {
    const content = extractUpstreamContent(upstream);
    const url = typeof content.imageUrl === 'string' ? content.imageUrl : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    upstreamImageEntries.push({ url, nodeId: upstream.id });
  }
  const orderedUrls = orderedReferenceUrlsWithOwnFirst(
    ownReferenceUrl,
    upstreamImageEntries.map((entry) => entry.url),
  );
  orderedUrls.forEach((url, index) => {
    const label = `${labelPrefix}${index + 1}`;
    out.set(label, {
      label,
      kind: 'image',
      thumbnailUrl: url,
      nodeId: upstreamImageEntries.find((entry) => entry.url === url)?.nodeId ?? null,
    });
  });
  return out;
}
