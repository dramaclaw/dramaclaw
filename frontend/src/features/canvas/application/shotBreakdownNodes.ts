// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  type AudioNodeData,
  type CanvasNodeData,
  type CanvasNodeType,
  type ImageGenNodeData,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { getNodeDefinition } from '@/features/canvas/domain/nodeRegistry';

/**
 * 逐帧拉片的产物落成画布节点。
 *
 * 关键的一条设计取舍：产物落成**普通的图片/视频/音频节点**，不新增「拉片素材」
 * 这种节点类型。这样下游任何生成节点都能直接连它——首尾帧图接图生视频、镜头
 * 片段接视频参考、音轨接配乐，一个连线矩阵都不用改。镜头语言写在节点名字里
 * （`S01｜中景·固定｜三人同框演奏`，后端 `format_frame_node_name` 拼的），
 * 结构化的那份留在任务结果的 `lens_material` 里给程序消费。
 *
 * 和 [[spawnExternalAssets]] 同构：纯函数 + 注入 deps，不现读 store。
 */

/** 组与组之间的留白。组自身的内边距由 `groupNodes` 负责。 */
const GROUP_GAP_Y = 80;
/** 源视频节点与第一组之间的水平留白。 */
const GROUP_GAP_X = 120;
/** 源节点没给宽度时的兜底，对齐 VideoNode 的默认宽。 */
const FALLBACK_TARGET_WIDTH = 480;

export type ShotBreakdownItemKind = 'image' | 'video' | 'audio';

export interface ShotBreakdownItem {
  kind: ShotBreakdownItemKind;
  name: string;
  url: string;
  shotIndex?: number;
  position?: 'first' | 'last';
  atSec?: number;
  startSec?: number;
  endSec?: number;
  durationSec?: number;
}

export interface ShotBreakdownLayout {
  positions: { x: number; y: number }[];
  width: number;
  height: number;
}

export interface ShotBreakdownGroup {
  key: string;
  name: string;
  layout: ShotBreakdownLayout;
  items: ShotBreakdownItem[];
}

const ITEM_NODE_TYPE: Record<ShotBreakdownItemKind, CanvasNodeType> = {
  image: CANVAS_NODE_TYPES.imageGen,
  video: CANVAS_NODE_TYPES.video,
  audio: CANVAS_NODE_TYPES.audio,
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeItem(raw: unknown): ShotBreakdownItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const kind = str(record.kind);
  const url = str(record.url);
  // 没有地址的条目落成节点就是一个永远空着的框，宁可少一个节点。
  if (!url || (kind !== 'image' && kind !== 'video' && kind !== 'audio')) return null;
  const position = str(record.position);
  return {
    kind,
    url,
    name: str(record.name),
    shotIndex: num(record.shot_index) ?? num(record.shotIndex),
    position: position === 'first' || position === 'last' ? position : undefined,
    atSec: num(record.at_sec) ?? num(record.atSec),
    startSec: num(record.start_sec) ?? num(record.startSec),
    endSec: num(record.end_sec) ?? num(record.endSec),
    durationSec: num(record.duration_sec) ?? num(record.durationSec),
  };
}

function normalizeLayout(raw: unknown, itemCount: number): ShotBreakdownLayout {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawPositions = Array.isArray(record.positions) ? record.positions : [];
  const positions = rawPositions
    .map((entry) => {
      const point = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      const x = num(point.x);
      const y = num(point.y);
      return x === undefined || y === undefined ? null : { x, y };
    })
    .filter((point): point is { x: number; y: number } => point !== null);
  // 后端没给坐标（老版本结果、或字段被裁掉）时退回竖排。少了布局只是不好看，
  // 而按 0,0 全叠在一起是彻底不可用。
  const fallback = Array.from({ length: itemCount }, (_, index) => ({ x: 0, y: index * 386 }));
  return {
    positions: positions.length === itemCount ? positions : fallback,
    width: num(record.width) ?? 808,
    height: num(record.height) ?? Math.max(1, itemCount) * 386,
  };
}

/** 把任务结果里的 `groups` 收成前端形状；结果形状变了也不会抛。 */
export function normalizeShotBreakdownGroups(raw: unknown): ShotBreakdownGroup[] {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawGroups = Array.isArray(record.groups) ? record.groups : [];
  const groups: ShotBreakdownGroup[] = [];
  for (const entry of rawGroups) {
    if (!entry || typeof entry !== 'object') continue;
    const group = entry as Record<string, unknown>;
    const items = (Array.isArray(group.items) ? group.items : [])
      .map(normalizeItem)
      .filter((item): item is ShotBreakdownItem => item !== null);
    if (items.length === 0) continue;
    groups.push({
      key: str(group.key),
      name: str(group.name),
      layout: normalizeLayout(group.layout, items.length),
      items,
    });
  }
  return groups;
}

function itemNodeData(item: ShotBreakdownItem): Partial<CanvasNodeData> {
  const type = ITEM_NODE_TYPE[item.kind];
  const defaults = getNodeDefinition(type).createDefaultData();
  const common = { displayName: item.name, user_spawned: true as const };
  if (item.kind === 'image') {
    return {
      ...(defaults as ImageGenNodeData),
      ...common,
      imageUrl: item.url,
    } as Partial<CanvasNodeData>;
  }
  if (item.kind === 'video') {
    return {
      ...(defaults as VideoNodeData),
      ...common,
      videoUrl: item.url,
      ...(item.durationSec
        ? { durationSec: item.durationSec, durationMs: Math.round(item.durationSec * 1000) }
        : {}),
    } as Partial<CanvasNodeData>;
  }
  return {
    ...(defaults as AudioNodeData),
    ...common,
    audioUrl: item.url,
  } as Partial<CanvasNodeData>;
}

export interface SpawnShotBreakdownTarget {
  id: string;
  position: { x: number; y: number };
  width?: number;
}

export interface SpawnShotBreakdownDeps {
  addNode: (
    type: CanvasNodeType,
    position: { x: number; y: number },
    data?: Partial<CanvasNodeData>,
  ) => string;
  addEdge: (source: string, target: string) => string | null;
  /** 把若干节点编成一个组；成员少于 2 个时返回 null（和 store 的行为一致）。 */
  groupNodes: (nodeIds: string[], opts?: { label?: string }) => string | null;
  /** 长任务期间源节点可能被用户删除；不存在时不得落一批失去来源的孤儿素材。 */
  targetExists?: (nodeId: string) => boolean;
}

export interface SpawnShotBreakdownResult {
  nodeIds: string[];
  groupIds: string[];
  /** 下一组该从哪个 y 开始——流式落节点时由调用方接着用。 */
  nextY: number;
}

/** 后端在任务跑完之前把已产好的分组推在 `task.metadata` 的这个 key 下。 */
export const STREAMED_GROUPS_KEY = 'shot_breakdown_groups';

/**
 * 从一次任务更新里读出已经产好的分组。
 *
 * 两个位置都看：跑的过程中在 `metadata`，跑完之后 task_state 会把 metadata
 * 挪进 `result.task_metadata`。只认一个位置的话，要么流式收不到，要么补齐
 * 那一次收不到。
 */
export function readStreamedGroups(task: {
  metadata?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
}): ShotBreakdownGroup[] {
  const fromMetadata = task.metadata?.[STREAMED_GROUPS_KEY];
  if (Array.isArray(fromMetadata)) return normalizeShotBreakdownGroups({ groups: fromMetadata });
  const taskMetadata = task.result?.task_metadata;
  if (taskMetadata && typeof taskMetadata === 'object') {
    const nested = (taskMetadata as Record<string, unknown>)[STREAMED_GROUPS_KEY];
    if (Array.isArray(nested)) return normalizeShotBreakdownGroups({ groups: nested });
  }
  return [];
}

/**
 * 把三个维度的产物摆到源视频节点右侧，每个维度编成一个组，并从源节点连一条边。
 *
 * 边连到**组**而不是组里的每个素材：一个 30 秒的片子能拆出二十多个节点，逐个
 * 连边会把画布糊成一团。连到组上既保留了「这堆素材是从这段视频拉出来的」这个
 * 来源关系，又只有三条线。组建不起来（只有一个成员）时退回连那个节点本身。
 */
export function spawnShotBreakdownNodes(
  target: SpawnShotBreakdownTarget,
  groups: readonly ShotBreakdownGroup[],
  deps: SpawnShotBreakdownDeps,
  startY?: number,
): SpawnShotBreakdownResult {
  if (deps.targetExists && !deps.targetExists(target.id)) {
    return { nodeIds: [], groupIds: [], nextY: startY ?? target.position.y };
  }
  const nodeIds: string[] = [];
  const groupIds: string[] = [];
  const baseX = target.position.x + (target.width || FALLBACK_TARGET_WIDTH) + GROUP_GAP_X;
  let cursorY = startY ?? target.position.y;

  for (const group of groups) {
    const memberIds: string[] = [];
    group.items.forEach((item, index) => {
      const offset = group.layout.positions[index] ?? { x: 0, y: index * 386 };
      const nodeId = deps.addNode(
        ITEM_NODE_TYPE[item.kind],
        { x: baseX + offset.x, y: cursorY + offset.y },
        itemNodeData(item),
      );
      memberIds.push(nodeId);
      nodeIds.push(nodeId);
    });

    const groupId = deps.groupNodes(memberIds, { label: group.name });
    if (groupId) groupIds.push(groupId);
    const edgeTarget = groupId ?? memberIds[0];
    if (edgeTarget) deps.addEdge(target.id, edgeTarget);

    cursorY += group.layout.height + GROUP_GAP_Y;
  }

  return { nodeIds, groupIds, nextY: cursorY };
}

/**
 * 流式落节点：三个维度各自跑完各自落，不必等最慢的那个（音乐维度要跑人声分离）。
 *
 * 后端每产好一个分组就把**累计**清单推一次，所以这里按 `key` 去重而不是按到达
 * 顺序——推送是幂等的，SSE 掉一两个事件也能在下一次自愈，而不会把同一组落两遍。
 */
export function createShotBreakdownSink(
  target: SpawnShotBreakdownTarget,
  deps: SpawnShotBreakdownDeps,
): {
  accept: (groups: readonly ShotBreakdownGroup[]) => SpawnShotBreakdownResult;
  spawnedKeys: () => string[];
} {
  const seen = new Set<string>();
  let cursorY = target.position.y;
  return {
    accept(groups) {
      if (deps.targetExists && !deps.targetExists(target.id)) {
        return { nodeIds: [], groupIds: [], nextY: cursorY };
      }
      const fresh = groups.filter((group) => group.key && !seen.has(group.key));
      if (fresh.length === 0) return { nodeIds: [], groupIds: [], nextY: cursorY };
      for (const group of fresh) seen.add(group.key);
      const result = spawnShotBreakdownNodes(target, fresh, deps, cursorY);
      cursorY = result.nextY;
      return result;
    },
    spawnedKeys: () => [...seen],
  };
}
