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

/**
 * 逐字段做大小写不敏感子串匹配。刻意逐字段 `.some()` 而不是把 prompt/label 拼成一个串:
 * 拼接会让「上一字段结尾 + 下一字段开头」凑出并不存在的命中(如 prompt「小猫」+ label
 * 「鱼缸」被「猫鱼」命中),而且生成历史里 prompt 与 label 往往是同一段提示词,拼接等于
 * 把每个资产的扫描量翻倍。
 *
 * 与 `filterBySearch`(components/assets/asset-search-box.tsx)同语义,但这里不 import 它
 * ——那是个 .tsx 组件模块,domain 层引它会把 React/shadcn 整条图拖进来。
 */
function matchesNeedle(asset: CanvasAsset, needle: string): boolean {
  return [asset.prompt, asset.label].some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
  );
}

/**
 * 关键词搜索命中判定(issue #175):匹配资产的提示词与展示名。
 *
 * 各来源的字段含义不同:生成历史里 prompt/label 都是那次生成的提示词(世界记录的 label
 * 会回退成上游节点名);live-canvas 取图时 prompt 恒为空、label 是节点名/文件名(见
 * `CanvasAsset.prompt` 注释)——所以那条路径上只有名字可搜,调用方的 placeholder 要相应
 * 改口,别承诺「搜提示词」。
 *
 * query 两端会被 trim、大小写不敏感;这里对查询词也 normalize 一次,不把「必须预先小写」
 * 当隐式前置条件(否则调用方直接传用户原文时,大写输入会静默零命中)。
 */
export function assetMatchesQuery(asset: CanvasAsset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return matchesNeedle(asset, needle);
}

/**
 * 按关键词过滤四个资产桶。空查询原样返回同一个对象(不复制)。四个桶都过滤(而非只过滤
 * 当前 tab),这样各 tab 的计数直接反映命中数,用户能看出该去哪个 tab 找。needle 只
 * normalize 一次,不在每个资产上重算。
 */
export function filterAssetBuckets(
  buckets: CanvasAssetBuckets,
  query: string,
): CanvasAssetBuckets {
  const needle = query.trim().toLowerCase();
  if (!needle) return buckets;
  const match = (asset: CanvasAsset) => matchesNeedle(asset, needle);
  return {
    image: buckets.image.filter(match),
    video: buckets.video.filter(match),
    audio: buckets.audio.filter(match),
    model: buckets.model.filter(match),
  };
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

/** 一个节点身上的一件原始资产（未经 `resolveMediaUrl` 归一）。 */
export interface CanvasNodeAsset {
  kind: CanvasAssetKind;
  /** 原件地址 —— 下载要拿的就是它，不是封面。 */
  url: string;
  /** 卡片/缩略图用的封面；视频、3D 世界这类没有静帧的资产才有值。 */
  previewUrl: string | null;
  /** 同一节点有多件时的区分位（分格图）。 */
  suffix?: string;
}

/**
 * 一个节点身上有哪些**原始**资产。这是「节点 → 可下载文件」的单一事实来源：资产
 * 库（{@link extractCanvasAssets}）与侧栏画布大纲都读它。
 *
 * 单独抽出来是因为这张表极易漏：视频合成的成片在 `resultVideoUrl`、视频故事的源
 * 片在 `sourceVideoUrl`、3D 世界的包在 `plyUrl`，而这三种节点身上同时挂着
 * `previewImageUrl`。谁自己写一版「取 videoUrl，否则回落到封面」，谁就会把海报当
 * 成片下载给用户。封面与原件在这里是两个字段，语义上分开。
 */
export function resolveNodeAssets(node: CanvasNode): CanvasNodeAsset[] {
  const data = asRecord(node.data);
  const one = (
    kind: CanvasAssetKind,
    url: string | null,
    previewUrl: string | null = null,
  ): CanvasNodeAsset[] => (url ? [{ kind, url, previewUrl }] : []);

  switch (node.type) {
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.imageGen:
    case CANVAS_NODE_TYPES.exportImage:
      return one('image', firstStr(data.imageUrl, data.committed_slot_url, data.previewImageUrl));
    case CANVAS_NODE_TYPES.pano360Viewer:
      // 全景查看器承载的就是那张球面贴图本身，原件即 imageUrl。
      return one('image', firstStr(data.imageUrl, data.previewImageUrl));
    case CANVAS_NODE_TYPES.storyboardSplit:
    case CANVAS_NODE_TYPES.storyboardGen: {
      const frames = Array.isArray(data.frames) ? data.frames : [];
      return frames.flatMap((frame, index) => {
        const frameData = asRecord(frame);
        const url = firstStr(frameData.imageUrl, frameData.previewImageUrl);
        return url
          ? [{ kind: 'image' as const, url, previewUrl: null, suffix: `frame-${index}` }]
          : [];
      });
    }
    case CANVAS_NODE_TYPES.video:
    case CANVAS_NODE_TYPES.videoStory:
      return one(
        'video',
        firstStr(data.videoUrl, data.sourceVideoUrl),
        str(data.previewImageUrl),
      );
    case CANVAS_NODE_TYPES.videoCompose:
      return one('video', firstStr(data.resultVideoUrl), str(data.previewImageUrl));
    case CANVAS_NODE_TYPES.audio:
      return one('audio', firstStr(data.audioUrl));
    case CANVAS_NODE_TYPES.threeDWorld:
      // The world's "asset" is its 3GS package (plyUrl, preferred) or a 360
      // pano image. The cover image is what we actually show on the card.
      return one('model', firstStr(data.plyUrl, data.panoUrl), str(data.previewImageUrl));
    default:
      return [];
  }
}

/**
 * 节点的主资产 —— 一个节点只允许一件「下载它」时该拿到的东西。分格类节点有多张图，
 * 取第一张（整个节点的批量下载由调用方自己遍历 {@link resolveNodeAssets}）。
 */
export function resolveNodePrimaryAsset(node: CanvasNode): CanvasNodeAsset | null {
  return resolveNodeAssets(node)[0] ?? null;
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

  for (const node of nodes) {
    const data = asRecord(node.data);
    const timestamp = timestampOf(data);
    const label = labelOf(data);

    for (const asset of resolveNodeAssets(node)) {
      const url = resolveMediaUrl(asset.url);
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      buckets[asset.kind].push({
        id: `${node.id}:${asset.suffix ?? ''}:${url}`,
        kind: asset.kind,
        url,
        previewUrl: resolveMediaUrl(asset.previewUrl),
        nodeId: node.id,
        label,
        timestamp,
      });
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
