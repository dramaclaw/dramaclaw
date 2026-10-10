// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  CANVAS_NODE_TYPES,
  isPendingUpscaleNode,
  resolveNodeSourceImageUrl,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

export type StoryboardCellKind = 'image' | 'video' | 'audio' | 'script' | 'empty';

export interface StoryboardCellPreview {
  nodeId: string;
  kind: StoryboardCellKind;
  /** Resolved thumbnail URL (image, or a video poster). Null → render a placeholder. */
  imageUrl: string | null;
  label: string;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function firstStr(...values: unknown[]): string | null {
  for (const value of values) {
    const resolved = str(value);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

// Display-safe resolver (identity for data:/blob:/http, passes /static through).
// Deliberately NOT resolveMediaUrl — that rejects data:/blob: URLs (a security
// rule for href/navigation), which would blank out freshly-uploaded local images.
function displayUrl(raw: string | null): string | null {
  return raw ? resolveImageDisplayUrl(raw) : null;
}

/**
 * Derive a compact thumbnail for one storyboard-board cell from its member node.
 * Mirrors the media fields used by `extractCanvasAssets`; non-media nodes fall
 * back to a kind placeholder so empty cells read like the libtv reference.
 */
export function getStoryboardCellPreview(node: CanvasNode): StoryboardCellPreview {
  const data = node.data as Record<string, unknown>;
  const label =
    firstStr((data as { displayName?: unknown }).displayName, (data as { label?: unknown }).label) ??
    '';

  // 还没出图的高清结果节点：它的 previewImageUrl 是待放大的**源图**，不是自己的
  // 内容。照常渲染出来用户会以为那就是放大后的效果，所以走空态占位（「待确认后
  // 生成」），与 liblib 一致。
  if (isPendingUpscaleNode(node)) {
    return { nodeId: node.id, kind: 'image', imageUrl: null, label };
  }

  // Type-specific kinds first (so video keeps its play badge, etc.).
  switch (node.type) {
    case CANVAS_NODE_TYPES.video:
    case CANVAS_NODE_TYPES.videoStory:
    case CANVAS_NODE_TYPES.videoCompose:
      return {
        nodeId: node.id,
        kind: 'video',
        imageUrl: displayUrl(str(data.previewImageUrl)),
        label,
      };
    case CANVAS_NODE_TYPES.storyboardSplit:
    case CANVAS_NODE_TYPES.storyboardGen: {
      const frames = Array.isArray(data.frames) ? data.frames : [];
      const firstFrame = frames.length > 0 ? (frames[0] as Record<string, unknown>) : null;
      return {
        nodeId: node.id,
        kind: 'image',
        imageUrl: firstFrame
          ? displayUrl(firstStr(firstFrame.imageUrl, firstFrame.previewImageUrl))
          : null,
        label,
      };
    }
    case CANVAS_NODE_TYPES.audio:
      return { nodeId: node.id, kind: 'audio', imageUrl: null, label };
    case CANVAS_NODE_TYPES.script:
    case CANVAS_NODE_TYPES.textAnnotation:
      return { nodeId: node.id, kind: 'script', imageUrl: null, label };
    default:
      break;
  }

  // Everything else: resolve the node's current image. Prefer the unified
  // resolver (upload / imageEdit / exportImage / imageGen incl. referenceImageUrl),
  // then a broad field sweep so any image-bearing node still renders a thumbnail.
  const sourceImage =
    resolveNodeSourceImageUrl(node) ??
    firstStr(
      data.imageUrl,
      data.previewImageUrl,
      data.referenceImageUrl,
      data.committed_slot_url,
      data.committedSlotUrl
    );
  if (sourceImage) {
    return { nodeId: node.id, kind: 'image', imageUrl: displayUrl(sourceImage), label };
  }

  // Image-kind node with nothing resolvable yet → image placeholder; else empty.
  const isImageKind =
    node.type === CANVAS_NODE_TYPES.upload ||
    node.type === CANVAS_NODE_TYPES.imageEdit ||
    node.type === CANVAS_NODE_TYPES.imageGen ||
    node.type === CANVAS_NODE_TYPES.exportImage;
  return { nodeId: node.id, kind: isImageKind ? 'image' : 'empty', imageUrl: null, label };
}
