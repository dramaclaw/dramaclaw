// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  ASSET_MIGRATION_KEY,
  copyAssetsInBatches,
  readAtPath,
  writeAtPath,
} from '@/features/canvas/application/crossProjectAssets';
import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';

/**
 * 保存被后端 `canvas_media_scope_mismatch` 拒绝之后的自愈。
 *
 * 静态资源按 URL 里的项目 id 独立鉴权，所以一张画布不能存别的项目的媒体地址：源项目
 * 成员看着一切正常，换个同样合法的本项目成员打开就是整片 403（SuperTale#192）。后端
 * 因此在 PUT 时拦下**本次新引入**的外项目引用，并回一份 `refs` 清单（节点 id + 字段
 * 路径 + 原 URL）。
 *
 * 这里把那份清单变成一次修复：素材拷进本项目（服务端 CopyObject，字节不过浏览器），
 * 新地址按字段路径填回节点，然后由调用方重试保存。拷不动的（源项目无权限 / 已删 /
 * 网络断）把字段置空并打上 `assetMigration: 'failed'` —— 保留原 URL 等于把 403 再存
 * 一次，后端下一轮还会拒，保存就永远卡死。
 *
 * 跨项目**粘贴**走的是另一条更早的路（`crossProjectAssets`：URL 压根不进 store）。
 * 本模块兜的是所有其他把外项目 URL 塞进画布的路径——撤销重做旧数据、模板/投影插入、
 * 以及将来任何新写法。
 */

export interface ForeignMediaRef {
  node_id: string;
  /** 节点 `data` 内的字段路径，例如 `cells[1].imageUrl`。 */
  field: string;
  url: string;
  source_project_id: string;
}

export const CANVAS_MEDIA_SCOPE_CODE = 'canvas_media_scope_mismatch';

function isForeignMediaRef(value: unknown): value is ForeignMediaRef {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.node_id === 'string' &&
    typeof ref.field === 'string' &&
    typeof ref.url === 'string' &&
    ref.url.length > 0 &&
    typeof ref.source_project_id === 'string'
  );
}

/**
 * 从保存错误里取出后端报的外项目引用；不是这个错误、或者一条可修的都没有就回 `null`
 * （让调用方按普通错误处理，别为一份空清单空转一轮拷贝 + 重试）。
 */
export function parseCanvasMediaScopeRefs(
  status: number | null,
  body: unknown,
): ForeignMediaRef[] | null {
  if (status !== 422 || !body || typeof body !== 'object') {
    return null;
  }
  const detail = (body as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object') {
    return null;
  }
  const record = detail as Record<string, unknown>;
  if (record.code !== CANVAS_MEDIA_SCOPE_CODE) {
    return null;
  }
  const refs = Array.isArray(record.refs) ? record.refs.filter(isForeignMediaRef) : [];
  return refs.length > 0 ? refs : null;
}

/** `cells[1].imageUrl` → `['cells', 1, 'imageUrl']`。解析不出来就回 `null`。 */
export function parseFieldPath(field: string): Array<string | number> | null {
  const path: Array<string | number> = [];
  const pattern = /([^.[\]]+)|\[(\d+)\]/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(field)) !== null) {
    if (match.index !== consumed && field[match.index - 1] !== '.') {
      return null;
    }
    consumed = match.index + match[0].length;
    path.push(match[2] !== undefined ? Number(match[2]) : match[1]);
  }
  if (consumed !== field.length || path.length === 0) {
    return null;
  }
  return path;
}

export interface ForeignMediaRepairResult {
  /** 原 URL → 本项目里的新 URL；调用方重试保存前也要拿它改自己手上的节点快照。 */
  urlMap: Map<string, string>;
  /** 没拷成的原 URL；对应字段已被置空。 */
  failedUrls: Set<string>;
}

/**
 * 把后端报的外项目引用拷进 `targetProject` 并填回节点。
 *
 * 只改「当前值仍然正是后端拒绝的那个 URL」的字段：拒绝到重试之间用户自己换了图，
 * 那是他的选择，不拿拷贝结果盖掉；节点已被删掉则整个跳过。相同 URL 只拷一次。
 */
export async function repairForeignMediaRefs(params: {
  refs: ForeignMediaRef[];
  targetProject: string;
  getLiveNodeData: (id: string) => CanvasNodeData | null;
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void;
  /**
   * 拷不动时是否把字段置空并标 `failed`。保存链路必须置空（保留源项目 URL 就等于把
   * 403 再存一次，后端下一轮还会拒，保存永远卡死）；读取期的手动修复不能置空——那份
   * 数据是历史遗留、后端已经放行，修不成也不该顺手把用户仅剩的线索删掉。
   */
  blankOnFailure?: boolean;
}): Promise<ForeignMediaRepairResult> {
  const { refs, targetProject, getLiveNodeData, updateNodeData } = params;
  const blankOnFailure = params.blankOnFailure ?? true;
  const sources = [...new Set(refs.map((ref) => ref.url))];
  const { mapping, failed } = await copyAssetsInBatches(targetProject, sources);
  // 后端按原字符串回映射；没出现在 mapping 也没出现在 failed 的（不该发生）一律算失败，
  // 免得字段带着源项目 URL 留在原地、下一轮保存再被拒。
  const failedUrls = new Set<string>(
    sources.filter((source) => !mapping.has(source) || failed.has(source)),
  );

  const byNode = new Map<string, ForeignMediaRef[]>();
  for (const ref of refs) {
    const bucket = byNode.get(ref.node_id);
    if (bucket) {
      bucket.push(ref);
    } else {
      byNode.set(ref.node_id, [ref]);
    }
  }

  for (const [nodeId, nodeRefs] of byNode) {
    const liveData = getLiveNodeData(nodeId);
    if (!liveData) {
      continue;
    }
    let nextData: unknown = liveData;
    let nodeFailed = false;
    for (const ref of nodeRefs) {
      const path = parseFieldPath(ref.field);
      if (!path) {
        nodeFailed = true;
        continue;
      }
      if (readAtPath(nextData, path) !== ref.url) {
        continue;
      }
      const newUrl = mapping.get(ref.url);
      if (newUrl) {
        nextData = writeAtPath(nextData, path, newUrl);
        continue;
      }
      nodeFailed = true;
      if (blankOnFailure) {
        nextData = writeAtPath(nextData, path, null);
      }
    }
    const previousData = liveData as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(nextData as Record<string, unknown>)) {
      if (value !== previousData[key]) {
        patch[key] = value;
      }
    }
    if (nodeFailed && blankOnFailure && previousData[ASSET_MIGRATION_KEY] !== 'failed') {
      patch[ASSET_MIGRATION_KEY] = 'failed';
    }
    if (Object.keys(patch).length > 0) {
      updateNodeData(nodeId, patch as Partial<CanvasNodeData>);
    }
  }

  const urlMap = new Map<string, string>();
  for (const source of sources) {
    const newUrl = mapping.get(source);
    if (newUrl) {
      urlMap.set(source, newUrl);
    }
  }
  return { urlMap, failedUrls };
}

/**
 * 把一次修复的结果套到「即将重试的那份节点快照」上。
 *
 * 修复已经写进了 store，但保存流程手上是发起这次 PUT 时的快照——不同步改一份，重试
 * 发出去的还是那些被拒的 URL，会原地死循环。没拷成的一律置空 + 标失败，理由同上。
 * 没有任何节点被改动时原样返回入参，避免下游无谓重渲染。
 */
export function applyForeignMediaRepairToNodes<
  T extends { id: string; data?: unknown },
>(nodes: readonly T[], refs: ForeignMediaRef[], repair: ForeignMediaRepairResult): T[] {
  const byNode = new Map<string, ForeignMediaRef[]>();
  for (const ref of refs) {
    const bucket = byNode.get(ref.node_id);
    if (bucket) {
      bucket.push(ref);
    } else {
      byNode.set(ref.node_id, [ref]);
    }
  }
  let changed = false;
  const next = nodes.map((node) => {
    const nodeRefs = byNode.get(node.id);
    if (!nodeRefs) {
      return node;
    }
    let data: unknown = node.data;
    let nodeChanged = false;
    let nodeFailed = false;
    for (const ref of nodeRefs) {
      const path = parseFieldPath(ref.field);
      if (!path || readAtPath(data, path) !== ref.url) {
        continue;
      }
      const newUrl = repair.urlMap.get(ref.url);
      data = writeAtPath(data, path, newUrl ?? null);
      nodeChanged = true;
      if (!newUrl) {
        nodeFailed = true;
      }
    }
    if (nodeFailed) {
      const record = data as Record<string, unknown>;
      if (record?.[ASSET_MIGRATION_KEY] !== 'failed') {
        data = { ...record, [ASSET_MIGRATION_KEY]: 'failed' };
        nodeChanged = true;
      }
    }
    if (!nodeChanged) {
      return node;
    }
    changed = true;
    return { ...node, data };
  });
  return changed ? next : (nodes as T[]);
}

// ——— 读取期诊断登记表 ————————————————————————————————————————————————
// GET 画布时后端会把「仍在服务的外项目引用」挂在 `foreign_media` 里（这些是守卫上线
// 之前存进去的历史数据，保存端放行，否则一个脏节点就把整张老画布锁死）。这里按节点
// 索引一份，节点遮罩订阅它，把裂图换成一句解释 + 一键修复。
//
// 刻意**不**写进节点 data：这是诊断信息，不是画布内容，不该落库、不该进撤销栈，也不该
// 让一次纯粹的读取把画布标记成"有改动"。

let foreignMediaProject = '';
const foreignMediaByNode = new Map<string, ForeignMediaRef[]>();
const foreignMediaListeners = new Set<() => void>();
const NO_REFS: ForeignMediaRef[] = [];

function notifyForeignMedia(): void {
  for (const listener of [...foreignMediaListeners]) {
    listener();
  }
}

/** 换画布 / 重新 hydrate 时整表替换：上一张画布的诊断绝不能留到下一张。 */
export function publishForeignMediaRefs(
  targetProject: string,
  refs: readonly ForeignMediaRef[],
): void {
  foreignMediaProject = targetProject;
  foreignMediaByNode.clear();
  for (const ref of refs) {
    const bucket = foreignMediaByNode.get(ref.node_id);
    if (bucket) {
      bucket.push(ref);
    } else {
      foreignMediaByNode.set(ref.node_id, [ref]);
    }
  }
  notifyForeignMedia();
}

export function clearForeignMediaRefs(): void {
  foreignMediaProject = '';
  foreignMediaByNode.clear();
  notifyForeignMedia();
}

/** 快照必须是稳定引用：干净节点一律回同一个空数组，否则 useSyncExternalStore 死循环。 */
export function readForeignMediaRefsForNode(nodeId: string): ForeignMediaRef[] {
  return foreignMediaByNode.get(nodeId) ?? NO_REFS;
}

export function foreignMediaTargetProject(): string {
  return foreignMediaProject;
}

export function subscribeForeignMediaRefs(listener: () => void): () => void {
  foreignMediaListeners.add(listener);
  return () => {
    foreignMediaListeners.delete(listener);
  };
}

/** 一处修好了就从登记表里摘掉；剩下的还留着（部分成功也要如实显示）。 */
export function resolveForeignMediaRefs(nodeId: string, urls: Iterable<string>): void {
  const bucket = foreignMediaByNode.get(nodeId);
  if (!bucket) {
    return;
  }
  const done = new Set(urls);
  const left = bucket.filter((ref) => !done.has(ref.url));
  if (left.length === bucket.length) {
    return;
  }
  if (left.length === 0) {
    foreignMediaByNode.delete(nodeId);
  } else {
    foreignMediaByNode.set(nodeId, left);
  }
  notifyForeignMedia();
}
