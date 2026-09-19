// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { Viewport } from '@xyflow/react';
import {
  CANVAS_NODE_TYPES,
  type AudioNodeData,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  type GroupNodeData,
  type ImageGenNodeData,
  type LiblibImportMetadata,
  type LiblibMediaNodeData,
  type LiblibNodeKind,
  type LiblibReference,
  type RemoteMediaRef,
  type TextAnnotationNodeData,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { getNodeDefinition } from '@/features/canvas/domain/nodeRegistry';
import { liblibImageThumbnailUrl, liblibVideoPosterUrl } from '@/features/canvas/domain/liblibMediaUrl';

type SourceNode = {
  nodeKey?: unknown;
  name?: unknown;
  type?: unknown;
  /**
   * LibTV is a React Flow canvas: `parentKey` is React Flow's `parentId`, so a
   * node that has one stores its position **relative to that parent**, not in
   * canvas space. Dropping it does not just lose the group box — it scatters
   * every member, because a relative offset read as absolute lands somewhere
   * else entirely.
   */
  parentKey?: unknown;
  position?: { positionX?: unknown; positionY?: unknown };
  measured?: { width?: unknown; height?: unknown };
  data?: unknown;
  createdAtMs?: unknown;
};

type SourceConnection = {
  connectionId?: unknown;
  source?: unknown;
  target?: unknown;
  sourceHandle?: unknown;
  targetHandle?: unknown;
};

export interface LiblibCanvasGraph {
  name: string;
  projectId: string;
  spaceId: string;
  shareUrl: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
}

export type LiblibCanvasImportErrorCode =
  | 'invalid_share_url'
  | 'response_mismatch'
  | 'response_missing_graph'
  | 'empty_graph'
  | 'canvas_conflict';

/**
 * Keep domain failures language-neutral. UI entry points translate `code`;
 * persisting a Chinese sentence in Error.message made English/Vietnamese
 * sessions leak Chinese and made callers compare prose instead of contracts.
 */
export class LiblibCanvasImportError extends Error {
  constructor(
    readonly code: LiblibCanvasImportErrorCode,
    readonly values: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = 'LiblibCanvasImportError';
  }
}

export function describeLiblibCanvasImportError(error: unknown): {
  code: string;
  values: Record<string, string | number>;
} | null {
  if (error instanceof LiblibCanvasImportError) {
    return { code: error.code, values: error.values };
  }
  if (!error || typeof error !== 'object') return null;
  const directCode = (error as { code?: unknown }).code;
  if (typeof directCode === 'string') return { code: directCode, values: {} };
  const body = (error as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return null;
  const detail = (body as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object') return null;
  const code = (detail as { code?: unknown }).code;
  return typeof code === 'string' ? { code, values: {} } : null;
}

export function parseLiblibShareUrl(value: string): { projectId: string; spaceId: string; shareUrl: string } {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new LiblibCanvasImportError('invalid_share_url');
  }
  const projectId = parsed.searchParams.get('projectId')?.toLowerCase() ?? '';
  const spaceId = parsed.searchParams.get('spaceId') ?? '';
  if (
    parsed.protocol !== 'https:' ||
    !['www.liblib.tv', 'liblib.tv'].includes(parsed.hostname) ||
    parsed.pathname.replace(/\/$/, '') !== '/canvas/share' ||
    !/^[0-9a-f]{32}$/.test(projectId) ||
    !/^\d+$/.test(spaceId)
  ) {
    throw new LiblibCanvasImportError('invalid_share_url');
  }
  return {
    projectId,
    spaceId,
    shareUrl: `https://www.liblib.tv/canvas/share?spaceId=${spaceId}&projectId=${projectId}`,
  };
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function sourceNodeData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * LibTV `nodeList[].type`: 1 text / 2 image / 3 video / 4 audio / 5 group.
 * `data.type` carries the same kind as a string and is the fallback for any
 * payload where the numeric code is missing.
 */
/**
 * LibTV 在 `data._resourceMeta.items[]` 里带着素材的真实像素尺寸
 * （`{kind, width, height}`，视频还有 `durationSec` / `byteSize`）。
 *
 * 为什么一定要把它带进来：节点数据里没有 `imageNaturalWidth/Height` 时，
 * `nodeBodyImageSrc()` 会拒绝挑降采样副本——那一次加载还兼着「量原图尺寸」的职责，
 * 必须是原图。对一张 3840×2160 的远端图，这一次就是约 33MB 的解码，而且每个没记录过
 * 的节点、每张新导入的画布都要再付一次。源数据里明明有这个数字，没有理由不写下来。
 */
function resourceMetaItem(
  data: Record<string, unknown>,
  kind: 'image' | 'video' | 'audio',
): { width?: number; height?: number; durationSec?: number } | null {
  const meta = data._resourceMeta;
  if (!meta || typeof meta !== 'object') return null;
  const items = (meta as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const match = items.find(
    (item) => Boolean(item) && typeof item === 'object' && (item as { kind?: unknown }).kind === kind,
  );
  return (match as { width?: number; height?: number; durationSec?: number } | undefined) ?? null;
}

/** 正数才算数：0 / 负数 / NaN 写进去只会让下游把它当成「量过了」而不再重量。 */
function positiveSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * LibTV 的 `NodeType` 枚举（读自他们前端产物）：
 * 1 TEXT / 2 IMAGE / 3 VIDEO / 4 AUDIO / 5 GROUP / 10 COMMENT / 15 TABLE /
 * 20 SCRIPT / 21 SCRIPT_V2 / 35 VIDEO_CLIP / 36 SPACE_SCENE_720 / 40 REFERENCE /
 * 45 SHOT_BREAKDOWN / 50 SCREENPLAY。
 *
 * 我们只有前五种的对应节点，但后面那些**身上大多挂着素材**——智能剪辑节点挂着
 * 剪好的视频，参考节点挂着被参考的图，拉片节点挂着产物。全部落成惰性卡片等于
 * 把一张画布里最有用的那部分丢掉。所以类型认不出来时改看它带的素材：
 * 有图就当图、有视频就当视频，实在什么都没有才落 `other`。
 */
const LIBLIB_TYPE_COMMENT = 10;

function liblibMediaKindFromData(data: Record<string, unknown>): LiblibNodeKind | null {
  const meta = data._resourceMeta;
  const items =
    meta && typeof meta === 'object' ? (meta as { items?: unknown }).items : null;
  if (Array.isArray(items)) {
    for (const item of items) {
      const kind =
        item && typeof item === 'object' ? (item as { kind?: unknown }).kind : null;
      if (kind === 'image' || kind === 'video' || kind === 'audio') return kind;
    }
  }
  // 没有元数据就看地址后缀。CDN 地址带 query，比较前先截掉。
  const url = firstHttpsUrl(data.url);
  if (url) {
    const path = url.split('?')[0].toLowerCase();
    if (/\.(png|jpe?g|webp|gif|bmp|avif)$/.test(path)) return 'image';
    if (/\.(mp4|webm|mov|m4v)$/.test(path)) return 'video';
    if (/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(path)) return 'audio';
  }
  return null;
}

function liblibNodeKind(type: unknown, data: Record<string, unknown>): LiblibNodeKind {
  if (type === 1 || data.type === 'text') return 'text';
  if (type === 2 || data.type === 'image') return 'image';
  if (type === 3 || data.type === 'video') return 'video';
  if (type === 4 || data.type === 'audio') return 'audio';
  if (type === 5 || data.type === 'group') return 'group';
  // 画布批注：内容就是一段文字，落成文本节点比落成素材卡贴切。
  if (type === LIBLIB_TYPE_COMMENT || data.type === 'comment') return 'text';
  return liblibMediaKindFromData(data) ?? 'other';
}

function firstHttpsUrl(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== 'string') return null;
  try {
    const url = new URL(first);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** 导入统计。曾经这里硬写 `downloaded_assets: true`——99 条素材一条都没存下来时
 * 它也照样是 true,等于把唯一能事后复盘的线索抹掉了。改成记真实条数。 */
export function liblibImportAssetStats(detail: unknown): { mirrored_assets: number; skipped_assets: number } {
  const raw = (detail ?? {}) as { assetMap?: unknown; skippedMedia?: unknown };
  const assetMap = raw.assetMap && typeof raw.assetMap === 'object' && !Array.isArray(raw.assetMap)
    ? raw.assetMap as Record<string, unknown>
    : {};
  return {
    mirrored_assets: Object.keys(assetMap).length,
    skipped_assets: Array.isArray(raw.skippedMedia) ? raw.skippedMedia.length : 0,
  };
}

function assetUrl(original: string | null, assetMap: Record<string, unknown>): string | null {
  if (!original) return null;
  const mapped = assetMap[original];
  return typeof mapped === 'string' && mapped.startsWith('/static/projects/') ? mapped : original;
}

/**
 * 这条地址有没有被本地化？没有就返回后端给的原因码。
 *
 * 只有**后端确实上报了跳过原因**才算「远端素材」。没开 download_assets 的预览调用
 * assetMap 是空的，那不代表素材有问题，不该给整张画布打满标记。
 */
function remoteMediaRefFor(
  original: string | null,
  assetMap: Record<string, unknown>,
  skippedReasons: Map<string, string>,
): RemoteMediaRef | null {
  if (!original) return null;
  const mapped = assetMap[original];
  if (typeof mapped === 'string' && mapped.startsWith('/static/projects/')) return null;
  const reason = skippedReasons.get(original);
  return reason ? { url: original, reason } : null;
}

/** LibTV stores a text body as `data.content: string[]` (one entry per result). */
function liblibText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter((item): item is string => typeof item === 'string').join('\n\n');
}

function referenceList(params: Record<string, unknown>, assetMap: Record<string, unknown>): LiblibReference[] {
  const mixed = Array.isArray(params.mixedList) && params.mixedList.length > 0;
  const rawItems = mixed ? params.mixedList
    : Array.isArray(params.imageList) && params.imageList.length > 0 ? params.imageList
    : Array.isArray(params.videoList) && params.videoList.length > 0 ? params.videoList
    : params.audioList;
  if (!Array.isArray(rawItems)) return [];
  const order = mixed ? params.mixedListOrder : params.imageListOrder;
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.nodeId === 'string') byId.set(record.nodeId, record);
  }
  const ordered = Array.isArray(order) && order.length > 0
    ? order.map((id) => typeof id === 'string' ? byId.get(id) : undefined).filter((item): item is Record<string, unknown> => Boolean(item))
    : [...byId.values()];
  return ordered.map((item) => {
    const mediaKind = item.mediaType === 'audio' ? 'audio' : item.mediaType === 'video' ? 'video' : 'image';
    const durationSec = finiteNumber(item.durationSec);
    const originalUrl = firstHttpsUrl(item.url);
    const remoteThumbnail = mediaKind === 'video'
      ? liblibVideoPosterUrl(originalUrl)
      : mediaKind === 'image' ? liblibImageThumbnailUrl(originalUrl) : null;
    return {
      nodeId: typeof item.nodeId === 'string' ? item.nodeId : null,
      url: assetUrl(originalUrl, assetMap),
      thumbnailUrl: assetUrl(remoteThumbnail, assetMap),
      label: typeof item.label === 'string' ? item.label : '',
      mediaKind,
      ...(durationSec !== null ? { durationSec } : {}),
    };
  });
}

/**
 * `params.textList` holds the upstream **text** nodes a generation consumed.
 * They carry no URL, so they are kept apart from the media references (which
 * drive `referenceOrder` / `genMode`) and only joined back for edge ordering.
 */
function textReferenceList(params: Record<string, unknown>): LiblibReference[] {
  const items = params.textList;
  if (!Array.isArray(items)) return [];
  const result: LiblibReference[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const text = liblibText(record.content);
    result.push({
      nodeId: typeof record.nodeId === 'string' ? record.nodeId : null,
      url: null,
      thumbnailUrl: null,
      label: typeof record.label === 'string' ? record.label : '',
      mediaKind: 'text',
      ...(text ? { text } : {}),
    });
  }
  return result;
}

/**
 * Per-kind box rules. `min`/`max` keep an imported card inside what the local
 * node component can actually render (TextAnnotationNode clamps itself to
 * 380..900 × 240..1200, VideoNode needs 380px of height for its controls), so
 * the stored box and the painted box stay the same rectangle.
 */
const NODE_BOX_RULES: Record<LiblibNodeKind, {
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}> = {
  // min 值必须等于各节点组件里的真实 MIN_WIDTH / MIN_HEIGHT，否则会出现两种错法：
  // 比真实下限小 —— 数据写 120，组件按 480 渲染，一拖拽就跳；
  // 比真实下限大 —— 无理由把源尺寸撑大。video 的 minHeight 曾经写成 380
  //（那是 DEFAULT_HEIGHT 不是 MIN_HEIGHT），把 LibTV 的 817x350 撑成 817x380；
  // audio 的 default 148 还低于它自己的 min 210，自相矛盾。
  image: { defaultWidth: 622, defaultHeight: 350, minWidth: 480, minHeight: 260, maxWidth: Infinity, maxHeight: Infinity },
  video: { defaultWidth: 817, defaultHeight: 350, minWidth: 480, minHeight: 280, maxWidth: Infinity, maxHeight: Infinity },
  audio: { defaultWidth: 480, defaultHeight: 210, minWidth: 360, minHeight: 190, maxWidth: Infinity, maxHeight: Infinity },
  text: { defaultWidth: 440, defaultHeight: 320, minWidth: 380, minHeight: 240, maxWidth: 900, maxHeight: 1200 },
  group: { defaultWidth: 400, defaultHeight: 300, minWidth: 220, minHeight: 140, maxWidth: Infinity, maxHeight: Infinity },
  other: { defaultWidth: 622, defaultHeight: 350, minWidth: 120, minHeight: 80, maxWidth: Infinity, maxHeight: Infinity },
};

const NODE_TYPE_BY_KIND: Record<LiblibNodeKind, CanvasNodeType> = {
  image: CANVAS_NODE_TYPES.imageGen,
  video: CANVAS_NODE_TYPES.video,
  audio: CANVAS_NODE_TYPES.audio,
  text: CANVAS_NODE_TYPES.textAnnotation,
  group: CANVAS_NODE_TYPES.group,
  other: CANVAS_NODE_TYPES.liblibMedia,
};

/**
 * Absolute canvas position of every node, following the `parentId` chain.
 * Members of a group store a relative offset, so anything that reasons about
 * canvas space (the import viewport) has to resolve it first.
 */
function absolutePositions(nodes: CanvasNode[]): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const cache = new Map<string, { x: number; y: number }>();
  const resolve = (node: CanvasNode, seen: Set<string>): { x: number; y: number } => {
    const cached = cache.get(node.id);
    if (cached) return cached;
    let point = { x: node.position.x, y: node.position.y };
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      const base = resolve(parent, seen);
      point = { x: base.x + point.x, y: base.y + point.y };
    }
    cache.set(node.id, point);
    return point;
  };
  for (const node of nodes) resolve(node, new Set([node.id]));
  return cache;
}

export function fitLiblibGraphViewport(
  nodes: CanvasNode[],
  size: { width: number; height: number },
): Viewport {
  if (nodes.length === 0) return { x: 0, y: 0, zoom: 1 };
  const absolute = absolutePositions(nodes);
  const points = nodes.map((node) => {
    const origin = absolute.get(node.id) ?? node.position;
    return {
      minX: origin.x,
      minY: origin.y,
      maxX: origin.x + (node.width ?? 622),
      maxY: origin.y + (node.height ?? 350),
    };
  });
  const minX = Math.min(...points.map((point) => point.minX));
  const minY = Math.min(...points.map((point) => point.minY));
  const maxX = Math.max(...points.map((point) => point.maxX));
  const maxY = Math.max(...points.map((point) => point.maxY));
  const width = Math.max(320, size.width);
  const height = Math.max(240, size.height);
  const padding = 48;
  const fitZoom = Math.min((width - padding * 2) / Math.max(1, maxX - minX), (height - padding * 2) / Math.max(1, maxY - minY));
  // LibTV's share viewer bottoms out at 10%; on very wide graphs the camera
  // starts at the first column and users pan horizontally through the rest.
  const zoom = Math.max(0.1, Math.min(0.8, fitZoom));
  const croppedHorizontally = fitZoom < 0.1;
  const centerX = croppedHorizontally ? minX : (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    x: (croppedHorizontally ? padding : width / 2) - centerX * zoom,
    y: height / 2 - centerY * zoom,
    zoom,
  };
}

/**
 * React Flow resolves `parentId` by array order: a member listed before its
 * group renders detached at the canvas origin. Emitting parents first (and
 * keeping LibTV's own order inside each depth) makes the graph safe to hand to
 * the store, to `PUT /freezone/canvas` and to a later rehydrate.
 */
function orderParentsFirst(nodes: CanvasNode[]): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depthOf = (node: CanvasNode): number => {
    let depth = 0;
    const seen = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId && !seen.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent) break;
      seen.add(parentId);
      depth += 1;
      parentId = parent.parentId;
    }
    return depth;
  };
  return nodes
    .map((node, index) => ({ node, index, depth: depthOf(node) }))
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
    .map((entry) => entry.node);
}

export function convertLiblibCanvasDetail(
  raw: Record<string, unknown>,
  shareUrl: string,
  size: { width: number; height: number },
  localModels: { imageModelId?: string; videoModelId?: string } = {},
): LiblibCanvasGraph {
  const share = parseLiblibShareUrl(shareUrl);
  const meta = raw.projectMeta as Record<string, unknown> | undefined;
  if (!meta || String(meta.uuid).toLowerCase() !== share.projectId || String(meta.projectSpaceId) !== share.spaceId) {
    throw new LiblibCanvasImportError('response_mismatch');
  }
  if (!Array.isArray(raw.nodeList) || !Array.isArray(raw.connectionList)) {
    throw new LiblibCanvasImportError('response_missing_graph');
  }
  const assetMap = raw.assetMap && typeof raw.assetMap === 'object' && !Array.isArray(raw.assetMap)
    ? raw.assetMap as Record<string, unknown>
    : {};
  // 后端上报的「没能本地保存」清单：{url, reason}。用来给节点打远端素材标记，
  // 并把原因一路带到界面上（远端素材喂不进本地模型、也不能当参考图）。
  const skippedReasons = new Map<string, string>();
  if (Array.isArray(raw.skippedMedia)) {
    for (const item of raw.skippedMedia) {
      if (!item || typeof item !== 'object') continue;
      const { url, reason } = item as { url?: unknown; reason?: unknown };
      if (typeof url === 'string' && url) {
        skippedReasons.set(url, typeof reason === 'string' && reason ? reason : 'unknown');
      }
    }
  }

  // Pass 1 — validate and normalise, so kinds (and therefore which ids are
  // groups) are known before any parent link is resolved.
  type Parsed = {
    id: string;
    kind: LiblibNodeKind;
    parentKey: string;
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
    data: Record<string, unknown>;
    params: Record<string, unknown>;
    createdAt: number | null;
  };
  const parsedNodes: Parsed[] = [];
  const seen = new Set<string>();
  for (const source of raw.nodeList as SourceNode[]) {
    const id = source.nodeKey;
    const x = finiteNumber(source.position?.positionX);
    const y = finiteNumber(source.position?.positionY);
    if (typeof id !== 'string' || !id || seen.has(id) || x === null || y === null) continue;
    seen.add(id);
    const parsedData = sourceNodeData(source.data);
    const params = parsedData.params && typeof parsedData.params === 'object' && !Array.isArray(parsedData.params)
      ? parsedData.params as Record<string, unknown>
      : {};
    const kind = liblibNodeKind(source.type, parsedData);
    const box = NODE_BOX_RULES[kind];
    const width = finiteNumber(source.measured?.width) ?? finiteNumber(parsedData.nodeWidth) ?? box.defaultWidth;
    const height = finiteNumber(source.measured?.height) ?? finiteNumber(parsedData.nodeHeight) ?? box.defaultHeight;
    const name = typeof source.name === 'string' && source.name.trim()
      ? source.name.trim()
      : typeof parsedData.name === 'string' ? parsedData.name : '';
    parsedNodes.push({
      id,
      kind,
      parentKey: typeof source.parentKey === 'string' ? source.parentKey : '',
      x,
      y,
      width: Math.min(box.maxWidth, Math.max(box.minWidth, width)),
      height: Math.min(box.maxHeight, Math.max(box.minHeight, height)),
      name,
      data: parsedData,
      params,
      createdAt: finiteNumber(source.createdAtMs),
      });
  }
  if (parsedNodes.length === 0) throw new LiblibCanvasImportError('empty_graph');

  const groupIds = new Set(parsedNodes.filter((node) => node.kind === 'group').map((node) => node.id));
  const parentById = new Map<string, string>();
  for (const node of parsedNodes) {
    // Only a group can parent, and only a parent that survived pass 1: a
    // dangling `parentKey` would make React Flow drop the child entirely.
    if (node.parentKey && node.parentKey !== node.id && groupIds.has(node.parentKey)) {
      parentById.set(node.id, node.parentKey);
    }
  }
  // A cycle (a group listed as its own ancestor) would hang position
  // resolution; break it by detaching the node that closes the loop.
  for (const [childId] of [...parentById]) {
    const visited = new Set<string>([childId]);
    let cursor = parentById.get(childId);
    while (cursor) {
      if (visited.has(cursor)) {
        parentById.delete(childId);
        break;
      }
      visited.add(cursor);
      cursor = parentById.get(cursor);
    }
  }

  const nodes: CanvasNode[] = [];
  for (const parsed of parsedNodes) {
    const { id, kind, params } = parsed;
    const sourceUrl = firstHttpsUrl(parsed.data.url);
    const localUrl = assetUrl(sourceUrl, assetMap);
    const remoteThumbnail = kind === 'image' ? liblibImageThumbnailUrl(sourceUrl) : null;
    const remotePoster = kind === 'video' ? liblibVideoPosterUrl(sourceUrl) : null;
    // i18n-exempt-start —— 与 nodeDisplay 的 DEFAULT_NODE_DISPLAY_NAME 同性质：
    // 这些是 LibTV 没给名字时写进画布 JSON 的规范默认值，不是界面文案（界面显示
    // 走 localizeNodeDisplayName），跟着界面语言变会污染落盘数据。
    const displayName = parsed.name
      || (kind === 'group' ? 'LibTV 分组' : kind === 'text' ? 'LibTV 文本' : 'LibTV 素材');
    // i18n-exempt-end
    const prompt = typeof params.prompt === 'string' ? params.prompt : '';
    const content = liblibText(parsed.data.content);
    const originalModel = typeof params.model === 'string' ? params.model : '';
    const mediaReferences = referenceList(params, assetMap);
    const references = [...mediaReferences, ...textReferenceList(params)];
    // 本节点自己的素材 + 它引用的素材，逐条看有没有落地。
    const remoteMedia = [
      remoteMediaRefFor(sourceUrl, assetMap, skippedReasons),
      ...mediaReferences.map((reference) =>
        remoteMediaRefFor(reference.url, assetMap, skippedReasons),
      ),
    ].filter((ref): ref is RemoteMediaRef => ref !== null);
    const uniqueRemoteMedia = [...new Map(remoteMedia.map((ref) => [ref.url, ref])).values()];
    const liblibImport: LiblibImportMetadata = {
      nodeKey: id,
      sourceUrl,
      importedLocalUrl: localUrl,
      importedPrompt: prompt,
      originalModel,
      references,
      liblibKind: kind,
      liblibAction: typeof parsed.data.action === 'string' ? parsed.data.action : '',
      parentKey: parsed.parentKey || null,
      importedContent: content,
      importedDisplayName: displayName,
      ...(uniqueRemoteMedia.length > 0 ? { remoteMedia: uniqueRemoteMedia } : {}),
    };
    const createdAt = parsed.createdAt;
    const type = NODE_TYPE_BY_KIND[kind];
    let data: CanvasNodeData;
    if (kind === 'image') {
      const defaults = getNodeDefinition(type).createDefaultData() as ImageGenNodeData;
      const model = localModels.imageModelId || defaults.model;
      data = {
        ...defaults,
        displayName,
        createdAt,
        imageUrl: localUrl,
        previewImageUrl: assetUrl(remoteThumbnail, assetMap),
        prompt,
        // LibTV model ids are provider-specific and cannot be submitted to the
        // local project gateway. Keep the source id in liblibImport metadata,
        // while the editable native node uses the project's live catalog.
        model,
        // 尺寸以源画布为准，不让组件在首帧按比例重算后覆盖掉。
        // 复用 isSizeManuallyAdjusted 这个既有开关：它的语义是「这个尺寸是权威的，
        // 别自动改」，而不只是「用户拖过」——见 planNaturalSizeRecordWrite 的
        // sizeLockedByUser，它只关掉 applySize，仍然会把量到的真实像素记下来。
        isSizeManuallyAdjusted: true,
        ...(() => {
          const item = resourceMetaItem(parsed.data, 'image');
          const width = positiveSize(item?.width);
          const height = positiveSize(item?.height);
          return width && height
            ? { imageNaturalWidth: width, imageNaturalHeight: height }
            : {};
        })(),
        liblibImport: { ...liblibImport, importedModel: model },
      } satisfies ImageGenNodeData;
    } else if (kind === 'video') {
      const defaults = getNodeDefinition(type).createDefaultData() as VideoNodeData;
      const model = localModels.videoModelId || defaults.model;
      data = {
        ...defaults,
        displayName,
        createdAt,
        videoUrl: localUrl,
        previewImageUrl: assetUrl(remotePoster, assetMap),
        prompt,
        model,
        genMode: mediaReferences.length > 0 ? 'allReference' : 'textToVideo',
        referenceOrder: mediaReferences.map((reference) => reference.nodeId).filter((ref): ref is string => Boolean(ref)),
        // 同上：源画布的尺寸是权威的。
        isSizeManuallyAdjusted: true,
        ...(() => {
          const item = resourceMetaItem(parsed.data, 'video');
          const width = positiveSize(item?.width);
          const height = positiveSize(item?.height);
          const durationSec = positiveSize(item?.durationSec);
          return {
            ...(width && height ? { widthPx: width, heightPx: height } : {}),
            ...(durationSec
              ? { durationSec, durationMs: Math.round(durationSec * 1000) }
              : {}),
          };
        })(),
        liblibImport: { ...liblibImport, importedModel: model },
      } satisfies VideoNodeData;
    } else if (kind === 'audio') {
      const defaults = getNodeDefinition(type).createDefaultData() as AudioNodeData;
      data = {
        ...defaults,
        displayName,
        createdAt,
        audioUrl: localUrl,
        text: prompt,
        liblibImport,
      } satisfies AudioNodeData;
    } else if (kind === 'text') {
      const defaults = getNodeDefinition(type).createDefaultData() as TextAnnotationNodeData;
      data = {
        ...defaults,
        displayName,
        createdAt,
        // LibTV's `data.content` is the body shown on the card; `params.prompt`
        // is the instruction that produced it (empty on a hand-written note).
        content,
        instruction: prompt,
        mode: 'writing',
        // Without this an imported note with an empty body would render the
        // "试试" capability picker instead of a text card.
        pickerDismissed: true,
        // The LibTV generator id (e.g. `aurora-3-prime`) is not in the local
        // catalog; keep it in metadata and leave the node on a usable model.
        model: defaults.model,
        liblibImport,
      } satisfies TextAnnotationNodeData;
    } else if (kind === 'group') {
      const defaults = getNodeDefinition(type).createDefaultData() as GroupNodeData;
      data = {
        ...defaults,
        displayName,
        label: displayName,
        createdAt,
        liblibImport,
      } satisfies GroupNodeData;
    } else {
      data = {
        displayName, mediaKind: 'other', sourceUrl, localUrl,
        prompt, model: originalModel, references,
        liblibNodeKey: id, createdAt,
        liblibImport,
      } satisfies LiblibMediaNodeData;
    }
    const parentId = parentById.get(id);
    nodes.push({
      id,
      type,
      position: { x: parsed.x, y: parsed.y },
      width: parsed.width,
      height: parsed.height,
      data,
      ...(parentId
        // No `extent: 'parent'`: LibTV members are not clamped to the box
        // either, and the local 打组 flow leaves it unset for the same reason.
        ? { parentId, extent: undefined }
        : {}),
      ...(kind === 'group'
        // GroupNode paints from `style`, the same shape canvasStore.groupNodes
        // writes when a group is created locally.
        ? { style: { width: parsed.width, height: parsed.height } }
        : {}),
    });
  }

  const orderedNodes = orderParentsFirst(nodes);
  const nodeById = new Map(orderedNodes.map((node) => [node.id, node]));
  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  for (const connection of raw.connectionList as SourceConnection[]) {
    const id = connection.connectionId;
    if (
      typeof id !== 'string' || edgeIds.has(id) ||
      typeof connection.source !== 'string' || !nodeById.has(connection.source) ||
      typeof connection.target !== 'string' || !nodeById.has(connection.target)
    ) continue;
    // Group boxes carry no handles on either canvas, so an edge touching one
    // would render as a stray line anchored to nothing.
    if (nodeById.get(connection.source)?.type === CANVAS_NODE_TYPES.group) continue;
    if (nodeById.get(connection.target)?.type === CANVAS_NODE_TYPES.group) continue;
    edgeIds.add(id);
    edges.push({
      id,
      source: connection.source,
      target: connection.target,
      sourceHandle: 'source',
      targetHandle: 'target',
      type: 'default',
      style: { stroke: 'rgb(var(--text-muted-rgb) / 0.55)', strokeWidth: 1.5 },
    });
  }
  const sourceOrder = new Map(orderedNodes.map((node) => [
    node.id,
    (node.data as { liblibImport?: LiblibImportMetadata }).liblibImport?.references.map((reference) => reference.nodeId) ?? [],
  ]));
  const groupedEdges = new Map<string, CanvasEdge[]>();
  for (const edge of edges) {
    const group = groupedEdges.get(edge.target) ?? [];
    group.push(edge);
    groupedEdges.set(edge.target, group);
  }
  const orderedEdges = [...groupedEdges.entries()].flatMap(([target, group]) => {
    const order = sourceOrder.get(target) ?? [];
    return group.sort((left, right) => {
      const leftIndex = order.indexOf(left.source);
      const rightIndex = order.indexOf(right.source);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    });
  });
  return {
    name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : 'LibTV 画布', // i18n-exempt: canonical persisted fallback
    projectId: share.projectId,
    spaceId: share.spaceId,
    shareUrl: share.shareUrl,
    nodes: orderedNodes,
    edges: orderedEdges,
    viewport: fitLiblibGraphViewport(orderedNodes, size),
  };
}

/**
 * Fields a refresh must not overwrite once the user has edited them locally,
 * paired with the metadata field holding the value this import last wrote.
 */
const PRESERVED_ON_REFRESH: Partial<Record<CanvasNodeType, Array<{
  field: string;
  imported: keyof LiblibImportMetadata;
}>>> = {
  [CANVAS_NODE_TYPES.imageGen]: [
    { field: 'prompt', imported: 'importedPrompt' },
    { field: 'imageUrl', imported: 'importedLocalUrl' },
  ],
  [CANVAS_NODE_TYPES.video]: [
    { field: 'prompt', imported: 'importedPrompt' },
    { field: 'videoUrl', imported: 'importedLocalUrl' },
  ],
  [CANVAS_NODE_TYPES.audio]: [
    { field: 'text', imported: 'importedPrompt' },
    { field: 'audioUrl', imported: 'importedLocalUrl' },
  ],
  [CANVAS_NODE_TYPES.textAnnotation]: [
    { field: 'content', imported: 'importedContent' },
    { field: 'instruction', imported: 'importedPrompt' },
  ],
  [CANVAS_NODE_TYPES.group]: [
    { field: 'label', imported: 'importedDisplayName' },
  ],
};

/** Refresh imported media while retaining native nodes and edits made on this canvas. */
export function mergeLiblibCanvasGraph(
  existingNodes: CanvasNode[],
  existingEdges: CanvasEdge[],
  graph: LiblibCanvasGraph,
): Pick<LiblibCanvasGraph, 'nodes' | 'edges'> {
  const isImported = (node: CanvasNode) => node.type === CANVAS_NODE_TYPES.liblibMedia
    || Boolean((node.data as { liblibImport?: LiblibImportMetadata }).liblibImport?.nodeKey);
  const importedIds = new Set(graph.nodes.map((node) => node.id));
  const existingById = new Map(existingNodes.map((node) => [node.id, node]));
  const nativeNodes = existingNodes.filter((node) => !isImported(node) && !importedIds.has(node.id));
  const refreshed = graph.nodes.map((node) => {
    const previous = existingById.get(node.id);
    if (!previous || !isImported(previous)) return node;
    const oldImport = (previous.data as { liblibImport?: LiblibImportMetadata }).liblibImport;
    // Keeping a position across a parent change would mix canvas space with a
    // group's local space — LibTV's layout wins in that case.
    const keepPosition = (previous.parentId ?? undefined) === (node.parentId ?? undefined);
    if (!oldImport || previous.type !== node.type) {
      return keepPosition ? { ...node, position: previous.position } : node;
    }
    const oldData = previous.data as Record<string, unknown>;
    const nextData = { ...node.data } as Record<string, unknown>;
    for (const { field, imported } of PRESERVED_ON_REFRESH[node.type] ?? []) {
      const importedValue = oldImport[imported];
      if (typeof importedValue === 'string' && oldData[field] !== importedValue) {
        nextData[field] = oldData[field];
      }
    }
    if (node.type === CANVAS_NODE_TYPES.group
      && typeof oldImport.importedDisplayName === 'string'
      && oldData.displayName !== oldImport.importedDisplayName) {
      nextData.displayName = oldData.displayName;
    }
    // Only preserve a model when the user changed the local catalog choice
    // after import. Metadata written by the legacy importer has no
    // importedModel; refresh those once so provider-specific LibTV ids cannot
    // leak into local generation requests.
    if (typeof oldImport.importedModel === 'string'
      && oldData.model !== oldImport.importedModel
      && typeof oldData.model === 'string') nextData.model = oldData.model;
    for (const field of ['size', 'quality', 'durationSec', 'modelParams', 'genMode', 'generationMode', 'count']) {
      if (field in oldData) nextData[field] = oldData[field];
    }
    return {
      ...node,
      ...(keepPosition ? { position: previous.position } : {}),
      data: nextData as CanvasNodeData,
    };
  });
  const validIds = new Set([...nativeNodes, ...refreshed].map((node) => node.id));
  const importedEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  const seenPairs = new Set(graph.edges.map((edge) => `${edge.source}\0${edge.target}`));
  const nativeEdges = existingEdges.filter((edge) => {
    const pair = `${edge.source}\0${edge.target}`;
    if (!validIds.has(edge.source) || !validIds.has(edge.target)
      || importedEdgeIds.has(edge.id) || seenPairs.has(pair)) return false;
    seenPairs.add(pair);
    return true;
  });
  return {
    // Parents stay ahead of their members; native nodes keep the order the
    // stored canvas already validated.
    nodes: orderParentsFirst([...refreshed, ...nativeNodes]),
    edges: [...graph.edges, ...nativeEdges],
  };
}
