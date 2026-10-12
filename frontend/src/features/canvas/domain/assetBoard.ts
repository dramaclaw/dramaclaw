// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { resolveMediaUrl } from '@/lib/media-url';

import { timestampOf } from './canvasAssets';
import {
  CANVAS_NODE_TYPES,
  isImageGenNode,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
} from './canvasNodes';
import { readKeyElementCategory, type KeyElementCategory } from './keyElements';
import { resolveNodeDisplayName } from './nodeDisplay';
import { getStoryboardCellPreview, type StoryboardCellPreview } from './storyboardCellPreview';
import { sortUpstreamByReferenceOrder } from '../nodes/referenceOrdering';

export type AssetBoardColumn = 'text' | 'image' | 'video' | 'audio';

export interface AssetBoardReference {
  /** 被引用的上游节点 id；节点自带参考图（referenceImageUrl）没有独立上游节点，为 null
   *  （与 promptReferences 里自带图那条同口径）。下游「定位」据此静默降级、「编辑」退化为灯箱看图。 */
  nodeId: string | null;
  label: string;
  thumbnailUrl: string;
}

export interface AssetBoardItem {
  nodeId: string;
  column: AssetBoardColumn;
  title: string;
  /** 主媒体地址（图片原图 / 视频 mp4 / 音频文件）；文本列恒为 null。 */
  mediaUrl: string | null;
  /** 卡片缩略图（图片本体 / 视频封面）；null → 渲染占位或视频首帧。 */
  thumbnailUrl: string | null;
  /** 文本列正文预览（80 字截断）。 */
  textPreview: string | null;
  /** 模型徽标（节点 data.model 原始 id）。 */
  model: string | null;
  /** 时长（秒，向下取整）；视频优先 durationSec，音频/上传视频由 durationMs 换算。 */
  durationSec: number | null;
  /** 真实像素尺寸。生成媒体多为空（已知数据缺口），有则展示。 */
  widthPx: number | null;
  heightPx: number | null;
  /** 视频列角色：视频合成产物 'final'（成片）/ 其余 'clip'（片段）；非视频列为 null。 */
  videoRole: 'final' | 'clip' | null;
  /** 上游参考素材（连线顺序 + referenceOrder 重排），只保留有缩略图的。 */
  references: AssetBoardReference[];
  /** committed_at / generationStartedAt 换算的时间戳，无则 null。仅信息性字段
   *  （如未来展示日期用）；栏内排序已改用节点创建顺序，不再依赖它。 */
  timestamp: number | null;
  /** 进行中：isGenerating ∨ isUploading（上传视频）∨ isAnalyzing（解析中），Boolean 归一。 */
  isGenerating: boolean;
  /** 生成开始时间戳（data.generationStartedAt 原样透传，非数字/缺失为 null）；
   *  卡片/详情用它 + 预估时长做进度百分比的时间估算（见 useEstimatedProgress）。 */
  generationStartedAt: number | null;
  /** 最近一次失败原因（generationError ?? analysisError ?? uploadError），无则 null。 */
  generationError: string | null;
  /** 关键元素分类（用户在节点「...」→ 设置关键元素 里打的标记）；未标记为 null。 */
  keyElementCategory: KeyElementCategory | null;
}

export interface AssetBoardData {
  text: AssetBoardItem[];
  image: AssetBoardItem[];
  video: AssetBoardItem[];
  audio: AssetBoardItem[];
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// 按 Unicode 码点截断（而非 UTF-16 code unit），避免代理对(surrogate pair，
// 例如 emoji)被从中间切开产生孤立代理项、渲染出乱码字符。
function clip80(value: string | null): string | null {
  if (!value) return null;
  const codePoints = Array.from(value);
  return codePoints.length > 80 ? `${codePoints.slice(0, 80).join('')}…` : value;
}

function columnOf(node: CanvasNode): AssetBoardColumn | null {
  switch (node.type) {
    case CANVAS_NODE_TYPES.textAnnotation:
    case CANVAS_NODE_TYPES.script:
    case CANVAS_NODE_TYPES.videoStory: // 分镜表：内容是镜头行，归文本列
    case CANVAS_NODE_TYPES.beatContext:
      return 'text';
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.imageGen:
    case CANVAS_NODE_TYPES.exportImage:
    case CANVAS_NODE_TYPES.storyboardSplit:
    case CANVAS_NODE_TYPES.storyboardGen:
      return 'image';
    case CANVAS_NODE_TYPES.video:
    case CANVAS_NODE_TYPES.videoCompose:
      return 'video';
    case CANVAS_NODE_TYPES.audio:
      return 'audio';
    default:
      // group / pano360Viewer / threeDWorld / skill 是结构或工具节点，不进故事板。
      return null;
  }
}

/**
 * 模型徽标文案：节点存的是渠道内部 id（`newapi_seedance-2.0-value`），直接摆到卡片上
 * 又长又像日志。这里只剥掉 `<渠道>_` 前缀（→ `seedance-2.0-value`），不做 id→展示名
 * 映射——展示名只有静态表里的模型才有，服务端下发的模型（happyhorse 等）查不到，
 * 混用会让同一栏里一半是「Seedance2.0 Value」一半是 `happyhorse-1.0`。
 */
export function modelBadgeLabel(modelId: string): string {
  const separator = modelId.indexOf('_');
  if (separator <= 0 || separator === modelId.length - 1) return modelId;
  return modelId.slice(separator + 1);
}

function textPreviewOf(node: CanvasNode, data: Record<string, unknown>): string | null {
  switch (node.type) {
    case CANVAS_NODE_TYPES.textAnnotation:
    case CANVAS_NODE_TYPES.beatContext:
      return clip80(str(data.content));
    case CANVAS_NODE_TYPES.script:
      return clip80(str(data.scriptTitle) ?? str(data.prompt));
    case CANVAS_NODE_TYPES.videoStory: {
      const rows = Array.isArray(data.rows) ? data.rows.length : 0;
      return rows > 0 ? `分镜表 · ${rows} 个镜头` : null;
    }
    default:
      return null;
  }
}

function mediaUrlOf(column: AssetBoardColumn, data: Record<string, unknown>, thumbnailUrl: string | null): string | null {
  switch (column) {
    case 'video':
      return resolveMediaUrl(str(data.videoUrl) ?? str(data.resultVideoUrl));
    case 'audio':
      return resolveMediaUrl(str(data.audioUrl));
    case 'image':
      // 图片的"原图"与缩略图同源（storyboardCellPreview 已解析 display-safe url）。
      return thumbnailUrl;
    default:
      return null;
  }
}

function durationSecOf(column: AssetBoardColumn, data: Record<string, unknown>): number | null {
  // durationSec 优先、durationMs 兜底，视频与音频同口径：只认 video 的话，记了
  // durationSec 的音频节点会显示不出时长，还会让 chip 白跑一次元数据探测。
  const explicit = num(data.durationSec);
  if ((column === 'video' || column === 'audio') && explicit !== null) return Math.floor(explicit);
  const ms = num(data.durationMs);
  if ((column === 'video' || column === 'audio') && ms !== null) return Math.floor(ms / 1000);
  return null;
}

/**
 * 单趟预建「目标节点 id → 上游节点(按连线顺序)」索引，语义与逐点调用
 * `upstreamNodesInEdgeOrder(nodes, edges, targetId)` 完全等价，但只扫一遍
 * `edges`（O(N+E) 而非每个下游节点各扫一遍全量 edges）。
 */
function buildUpstreamIndex(nodes: CanvasNode[], edges: CanvasEdge[]): Map<string, CanvasNode[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const index = new Map<string, CanvasNode[]>();
  for (const e of edges) {
    const source = byId.get(e.source);
    if (!source) continue;
    const list = index.get(e.target);
    if (list) {
      list.push(source);
    } else {
      index.set(e.target, [source]);
    }
  }
  return index;
}

/** `getStoryboardCellPreview` 惰性缓存：同一上游节点被多个下游消费者引用时只算一次。 */
function getCachedPreview(
  node: CanvasNode,
  cache: Map<string, StoryboardCellPreview>,
): StoryboardCellPreview {
  const cached = cache.get(node.id);
  if (cached) return cached;
  const preview = getStoryboardCellPreview(node);
  cache.set(node.id, preview);
  return preview;
}

function referencesOf(
  node: CanvasNode,
  upstreamIndex: Map<string, CanvasNode[]>,
  previewCache: Map<string, StoryboardCellPreview>,
): AssetBoardReference[] {
  const upstream = upstreamIndex.get(node.id) ?? [];
  const referenceOrder = asRecord(node.data).referenceOrder;
  const ordered = sortUpstreamByReferenceOrder(
    upstream,
    Array.isArray(referenceOrder) ? (referenceOrder as string[]) : undefined,
  );
  const refs: AssetBoardReference[] = [];
  const seenUrls = new Set<string>();

  // 节点自带参考图（imageGen 用户从资产库/替换素材直接选到 data.referenceImageUrl、
  // 没有上游连线的那张）排第 1，口径对齐 @图片N 编号（orderedReferenceUrlsWithOwnFirst：
  // 自带图在前、URL 去重）。它没有独立上游节点，nodeId 记为 null（对齐 promptReferences
  // 里自带图那条），「定位」无处可滚→静默、「编辑」→ 灯箱看图，均优雅降级不报错。
  // 仅 imageGen 有 referenceImageUrl 概念（与 promptReferences 只对 isImageGenNode 前置一致）。
  if (isImageGenNode(node)) {
    const rawOwn = asRecord(node.data).referenceImageUrl;
    const ownUrl =
      typeof rawOwn === 'string' && rawOwn.length > 0 ? resolveImageDisplayUrl(rawOwn) : null;
    if (ownUrl) {
      refs.push({ nodeId: null, label: '参考图', thumbnailUrl: ownUrl });
      seenUrls.add(ownUrl);
    }
  }

  for (const up of ordered) {
    if (!up.type) continue;
    const preview = getCachedPreview(up, previewCache);
    if (!preview.imageUrl) continue; // 参考行只放有缩略图的上游（同 liblib）
    if (seenUrls.has(preview.imageUrl)) continue; // 与自带图同 URL → 只保留最前一条（同 orderedReferenceUrlsWithOwnFirst）
    seenUrls.add(preview.imageUrl);
    refs.push({
      nodeId: up.id,
      label: resolveNodeDisplayName(up.type, asRecord(up.data) as Partial<CanvasNodeData>),
      thumbnailUrl: preview.imageUrl,
    });
  }
  return refs;
}

/**
 * 故事板视图的数据推导：把画布节点按媒介类型分进 text/image/video/audio 四桶。
 * 纯函数（对标 liblib「故事板 = 图数据第二投影」的机制），调用方用
 * `useMemo(() => buildAssetBoard(nodes, edges), [nodes, edges])` 订阅。
 */
export function buildAssetBoard(nodes: CanvasNode[], edges: CanvasEdge[]): AssetBoardData {
  const board: AssetBoardData = { text: [], image: [], video: [], audio: [] };
  const upstreamIndex = buildUpstreamIndex(nodes, edges);
  const previewCache = new Map<string, StoryboardCellPreview>();

  // 节点在画布中的创建顺序：nodes 数组序（canvasStore.addNode append 到末尾），
  // 索引越大越新。作栏内排序的新近度信号，见下方 newestFirst 说明。
  const creationOrder = new Map<string, number>();
  nodes.forEach((node, index) => creationOrder.set(node.id, index));

  for (const node of nodes) {
    if (!node.type) continue;
    const column = columnOf(node);
    if (!column) continue;
    const data = asRecord(node.data);
    const preview = getCachedPreview(node, previewCache);
    const thumbnailUrl = preview.imageUrl;

    board[column].push({
      nodeId: node.id,
      column,
      title: resolveNodeDisplayName(node.type, data as Partial<CanvasNodeData>),
      mediaUrl: mediaUrlOf(column, data, thumbnailUrl),
      thumbnailUrl,
      textPreview: column === 'text' ? textPreviewOf(node, data) : null,
      model: str(data.model),
      durationSec: durationSecOf(column, data),
      widthPx: num(data.widthPx),
      heightPx: num(data.heightPx),
      videoRole:
        column !== 'video' ? null : node.type === CANVAS_NODE_TYPES.videoCompose ? 'final' : 'clip',
      references:
        column === 'image' || column === 'video'
          ? referencesOf(node, upstreamIndex, previewCache)
          : [],
      timestamp: timestampOf(data),
      isGenerating: Boolean(data.isGenerating) || Boolean(data.isUploading) || Boolean(data.isAnalyzing),
      generationError: str(data.generationError) ?? str(data.analysisError) ?? str(data.uploadError),
      generationStartedAt: num(data.generationStartedAt),
      keyElementCategory: readKeyElementCategory(data),
    });
  }

  // 栏内排序：按节点创建顺序（nodes 数组序）新→旧，最新建/最新生成的节点排在最上面
  // （对标 liblib）。刻意不用 committed_at / generationStartedAt 时间戳排序：
  //   1) 普通生成节点没有 committed_at，且 generationStartedAt 在生成完成时被清成 null
  //      —— 靠时间戳会让「刚生成完的节点」时间戳为 null 而沉底（正是用户反馈的 bug）；
  //   2) generationStartedAt 只在生成中存在，用它排序会让同一节点在「生成中↔完成」间
  //      上下跳动。创建顺序在整个生成生命周期内稳定，位置不跳。
  const newestFirst = (a: AssetBoardItem, b: AssetBoardItem) =>
    (creationOrder.get(b.nodeId) ?? -1) - (creationOrder.get(a.nodeId) ?? -1);
  board.text.sort(newestFirst);
  board.image.sort(newestFirst);
  board.video.sort(newestFirst);
  board.audio.sort(newestFirst);
  return board;
}
