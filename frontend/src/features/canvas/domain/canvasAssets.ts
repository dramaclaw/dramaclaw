// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { resolveMediaUrl } from '@/lib/media-url';

import { CANVAS_NODE_TYPES, type CanvasNode } from './canvasNodes';

export type CanvasAssetKind = 'image' | 'video' | 'audio' | 'model';

export interface CanvasAsset {
  /** Stable key, unique per (node, media url). */
  id: string;
  kind: CanvasAssetKind;
  /** Resolved, render-safe media url. */
  url: string;
  /** Poster / thumbnail for video & audio cards (resolved); null when none. */
  previewUrl: string | null;
  nodeId: string;
  /** Display name from the node, falls back to a kind label upstream. */
  label: string | null;
  /**
   * Generation prompt recorded on this asset. Only populated in the
   * generation-history source (where each record carries the exact prompt that
   * produced it); left undefined for live-canvas assets whose `label` is a node
   * display name, not a prompt. Used to seed a new node's prompt box on 使用.
   */
  prompt?: string | null;
  /** 原始生成的注册表模型 id（还原用）。旧记录为 undefined。 */
  model?: string | null;
  /** 原始生成模式（还原用）。旧记录为 undefined。 */
  genMode?: string | null;
  /** Best-effort creation time in ms epoch; null when the node carries none. */
  timestamp: number | null;
}

export interface CanvasAssetBuckets {
  image: CanvasAsset[];
  video: CanvasAsset[];
  audio: CanvasAsset[];
  /** Director-world (3GS / 360 pano) assets. `url` is the .sog/.ply package or
   *  pano image; `previewUrl` is the cover used as a card thumbnail. */
  model: CanvasAsset[];
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** First non-empty string among the candidates. */
function firstStr(...values: unknown[]): string | null {
  for (const value of values) {
    const resolved = str(value);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

/**
 * Best-effort creation timestamp. Image nodes carry an ISO `committed_at`;
 * generative nodes keep a numeric `generationStartedAt`. Returns null when the
 * node has neither so the caller can bucket it under an "unknown date" group.
 */
function timestampOf(data: Record<string, unknown>): number | null {
  const committed = str(data.committed_at);
  if (committed) {
    const parsed = Date.parse(committed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  const started = data.generationStartedAt;
  if (typeof started === 'number' && Number.isFinite(started)) {
    return started;
  }
  return null;
}

function labelOf(data: Record<string, unknown>): string | null {
  return firstStr(data.displayName, data.sourceFileName);
}

/**
 * Pull every image / video / audio asset out of the live canvas nodes.
 *
 * The history panel reads straight from the in-memory canvas (no backend
 * round-trip): we walk each node, pick the media url that matches its kind, and
 * dedupe by resolved url so the same asset referenced twice shows once.
 */
export function extractCanvasAssets(nodes: CanvasNode[]): CanvasAssetBuckets {
  const buckets: CanvasAssetBuckets = { image: [], video: [], audio: [], model: [] };
  const seen = new Set<string>();

  const push = (
    kind: CanvasAssetKind,
    rawUrl: string | null,
    options: { nodeId: string; previewUrl?: string | null; label: string | null; timestamp: number | null; suffix?: string },
  ) => {
    const url = resolveMediaUrl(rawUrl);
    if (!url || seen.has(url)) {
      return;
    }
    seen.add(url);
    buckets[kind].push({
      id: `${options.nodeId}:${options.suffix ?? ''}:${url}`,
      kind,
      url,
      previewUrl: resolveMediaUrl(options.previewUrl ?? null),
      nodeId: options.nodeId,
      label: options.label,
      timestamp: options.timestamp,
    });
  };

  for (const node of nodes) {
    const data = asRecord(node.data);
    const timestamp = timestampOf(data);
    const label = labelOf(data);

    switch (node.type) {
      case CANVAS_NODE_TYPES.upload:
      case CANVAS_NODE_TYPES.imageEdit:
      case CANVAS_NODE_TYPES.imageGen:
      case CANVAS_NODE_TYPES.exportImage: {
        push('image', firstStr(data.imageUrl, data.committed_slot_url, data.previewImageUrl), {
          nodeId: node.id,
          label,
          timestamp,
        });
        break;
      }
      case CANVAS_NODE_TYPES.storyboardSplit:
      case CANVAS_NODE_TYPES.storyboardGen: {
        const frames = Array.isArray(data.frames) ? data.frames : [];
        frames.forEach((frame, index) => {
          const frameData = asRecord(frame);
          push('image', firstStr(frameData.imageUrl, frameData.previewImageUrl), {
            nodeId: node.id,
            label,
            timestamp,
            suffix: `frame-${index}`,
          });
        });
        break;
      }
      case CANVAS_NODE_TYPES.video:
      case CANVAS_NODE_TYPES.videoStory: {
        push('video', firstStr(data.videoUrl, data.sourceVideoUrl), {
          nodeId: node.id,
          previewUrl: str(data.previewImageUrl),
          label,
          timestamp,
        });
        break;
      }
      case CANVAS_NODE_TYPES.videoCompose: {
        push('video', firstStr(data.resultVideoUrl), {
          nodeId: node.id,
          previewUrl: str(data.previewImageUrl),
          label,
          timestamp,
        });
        break;
      }
      case CANVAS_NODE_TYPES.audio: {
        push('audio', firstStr(data.audioUrl), {
          nodeId: node.id,
          label,
          timestamp,
        });
        break;
      }
      case CANVAS_NODE_TYPES.threeDWorld: {
        // The world's "asset" is its 3GS package (plyUrl, preferred) or a 360
        // pano image. The cover image is what we actually show on the card.
        push('model', firstStr(data.plyUrl, data.panoUrl), {
          nodeId: node.id,
          previewUrl: str(data.previewImageUrl),
          label,
          timestamp,
        });
        break;
      }
      default:
        break;
    }
  }

  return buckets;
}

export interface CanvasAssetDateGroup {
  /** `YYYY-MM-DD`, or null for assets without a usable timestamp. */
  date: string | null;
  assets: CanvasAsset[];
}

function dateKey(timestamp: number | null): string | null {
  if (timestamp === null) {
    return null;
  }
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Group assets by calendar day and sort. Dated groups come first (ordered by
 * `direction`); the undated bucket always sinks to the end.
 */
export function groupAssetsByDate(
  assets: CanvasAsset[],
  direction: 'desc' | 'asc',
): CanvasAssetDateGroup[] {
  const groups = new Map<string | null, CanvasAsset[]>();
  for (const asset of assets) {
    const key = dateKey(asset.timestamp);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(asset);
    } else {
      groups.set(key, [asset]);
    }
  }

  const sortByTime = (a: CanvasAsset, b: CanvasAsset) => {
    const ta = a.timestamp ?? 0;
    const tb = b.timestamp ?? 0;
    return direction === 'desc' ? tb - ta : ta - tb;
  };

  const dated: CanvasAssetDateGroup[] = [];
  let undated: CanvasAsset[] | null = null;
  for (const [key, bucket] of groups) {
    bucket.sort(sortByTime);
    if (key === null) {
      undated = bucket;
    } else {
      dated.push({ date: key, assets: bucket });
    }
  }

  dated.sort((a, b) =>
    direction === 'desc' ? (a.date! < b.date! ? 1 : -1) : a.date! < b.date! ? -1 : 1,
  );

  if (undated) {
    dated.push({ date: null, assets: undated });
  }
  return dated;
}
