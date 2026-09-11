// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {CanvasNode} from '@/features/canvas/domain/canvasNodes';
import {extractUpstreamContent} from '@/features/canvas/application/graphContentResolver';

export const HTML_REFERENCE_PREFIXES = ['文本', '图片', '视频', '音频'] as const;
export interface HtmlReference {
  nodeId: string;
  name: string;
  prefix: typeof HTML_REFERENCE_PREFIXES[number];
  mention: string;
  index: number;
  text?: string;
  url?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  durationMs?: number;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.round(left);
  let b = Math.round(right);
  while (b > 0) [a, b] = [b, a % b];
  return a || 1;
}

function mediaAspectRatio(
  width: number | undefined,
  height: number | undefined,
  stored: unknown,
): string | undefined {
  if (width && height) {
    const divisor = greatestCommonDivisor(width, height);
    return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
  }
  return typeof stored === 'string' && stored.trim() ? stored.trim() : undefined;
}

/** Shared by the editor and generation request; URLs here are canonical, not display URLs. */
export function buildHtmlReferences(nodes: CanvasNode[]): HtmlReference[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  return nodes.flatMap(node => {
    if (seen.has(node.id)) return [];
    seen.add(node.id);
    const content = extractUpstreamContent(node);
    const data = node.data as Record<string, unknown>;
    const videoUrl = node.type === 'videoComposeNode' ? data.videoUrl as string | undefined : content.videoUrl;
    const prefix = node.type === 'textAnnotationNode' || node.type === 'scriptNode' ? '文本'
      : node.type === 'audioNode' ? '音频'
      : videoUrl || node.type === 'videoNode' || node.type === 'videoComposeNode' ? '视频'
      : content.imageUrl || ['imageGenNode','imageNode','uploadNode','exportImageNode','storyboardGenNode'].includes(node.type) ? '图片' : null;
    if (!prefix) return [];
    const index = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, index);
    const imageUrl = node.type === 'imageGenNode' ? data.imageUrl as string | undefined : content.imageUrl;
    const width = positiveNumber(prefix === '视频' ? data.widthPx : data.imageNaturalWidth);
    const height = positiveNumber(prefix === '视频' ? data.heightPx : data.imageNaturalHeight);
    return [{nodeId: node.id, name: content.displayName || `${prefix}${index}`, prefix, index,
      mention: `${prefix}${index}`, text: content.text,
      url: prefix === '视频' ? videoUrl : prefix === '音频' ? content.audioUrl : prefix === '图片' ? imageUrl : undefined,
      width,
      height,
      aspectRatio: prefix === '图片' || prefix === '视频'
        ? mediaAspectRatio(width, height, data.aspectRatio)
        : undefined,
      durationMs: prefix === '视频' ? positiveNumber(data.durationMs) : undefined,
    }];
  });
}
