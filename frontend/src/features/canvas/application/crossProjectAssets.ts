// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { copyFreezoneAssets } from '@/api/ops';
import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';

/**
 * 跨项目粘贴时的资产迁移。
 *
 * 画布的复制/粘贴只是深拷贝节点数据，媒体 URL（videoUrl / imageUrl / audioUrl …）
 * 原样保留，仍指向「源项目」的静态路径。粘贴到另一个项目后，这些资产并不属于
 * 目标项目（不进素材库、源项目一删即失效、非源项目成员打开直接 403）。
 *
 * 约束：**源项目的 URL 任何时候都不进 store、不落库。** 粘贴时先用
 * `withholdForeignAssetUrls` 把这些字段置空、记下位置，节点带着
 * `assetMigration: 'copying'` 入 store（节点外壳渲染「素材复制中」占位）；再把记下的
 * URL 交给后端 `freezone/assets/copy`，由后端在服务端把文件拷进目标项目（OSS 部署下是
 * CopyObject，字节不经过浏览器）；成功后把目标项目的新地址填回原位置、摘掉标记，节点
 * 才算完整；失败则保持字段为空、标记 `'failed'`，让用户删掉重贴。自动保存在迁移期间
 * 即使被超时恢复，落库的也只是「无 URL 的占位节点」，不会带上源项目地址。
 *
 * 识别策略：递归遍历节点数据，凡是 key 以 `Url` 结尾、值是「同源 /static/projects/<pid>/…
 * 或 /api/v1/projects/<pid>/media/… 路径」的字符串就迁移。这样无需维护字段白名单，
 * 叠卡画册 / 分镜帧等嵌套结构也自动覆盖。
 */

// 单次请求最多带多少个 URL：后端一次请求上限 200，留余量，也让大批粘贴分批出结果。
const COPY_BATCH_SIZE = 64;

const STATIC_PROJECT_PREFIX = '/static/projects/';
const MEDIA_PROJECT_RE = /^\/api\/v1\/projects\/([^/]+)\/media\/.+/;

interface CopyableAsset {
  /** 发给后端的同源路径（含查询串，后端按原字符串回映射）。 */
  source: string;
  /** URL 指向的项目 id（已解码）。 */
  project: string;
}

/**
 * 把存储的原始 URL 归一化成「后端能拷的同源项目路径」。
 *
 * 关键：**不**走 `resolveMediaUrl`——它会把 legacy `/static/<user>/<project>/…`
 * 按当前路由项目重锚定。这里只认带项目 id 的 canonical 形式；legacy 形式后端已经
 * 410，也没法按项目授权，直接不收。
 */
function toCopyableAsset(raw: string): CopyableAsset | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // data: / blob: 不是跨项目静态资产；protocol-relative 一律拒绝。
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('//')) {
    return null;
  }
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  let parsed: URL;
  try {
    parsed = new URL(trimmed, origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  // 跨源媒体本部署不支持（后端 /static 始终同源经边缘代理）。
  if (typeof window !== 'undefined' && parsed.origin !== window.location.origin) {
    return null;
  }
  const project = projectIdFromPath(parsed.pathname);
  if (!project) {
    return null;
  }
  return { source: parsed.pathname + parsed.search, project };
}

function projectIdFromPath(pathname: string): string | null {
  let encoded: string | null = null;
  if (pathname.startsWith(STATIC_PROJECT_PREFIX)) {
    const rest = pathname.slice(STATIC_PROJECT_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash > 0 && slash < rest.length - 1) {
      encoded = rest.slice(0, slash);
    }
  } else {
    const match = MEDIA_PROJECT_RE.exec(pathname);
    if (match) {
      encoded = match[1];
    }
  }
  if (!encoded) {
    return null;
  }
  try {
    return decodeURIComponent(encoded) || null;
  } catch {
    return null;
  }
}

/** 节点数据里的迁移状态字段；只有跨项目粘贴进来、且带外项目媒体的节点才有。 */
export const ASSET_MIGRATION_KEY = 'assetMigration';

export type AssetMigrationState = 'copying' | 'failed';

export function readAssetMigrationState(data: unknown): AssetMigrationState | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const value = (data as Record<string, unknown>)[ASSET_MIGRATION_KEY];
  return value === 'copying' || value === 'failed' ? value : null;
}

/** 一处被置空的媒体字段：在节点数据里的路径 + 原来指向源项目的 URL。 */
export interface WithheldAssetRef {
  path: Array<string | number>;
  url: string;
}

function withholdInto(
  value: unknown,
  targetProject: string,
  path: Array<string | number>,
  out: WithheldAssetRef[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => withholdInto(item, targetProject, [...path, index], out));
  }
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string' && /url$/i.test(key)) {
        const asset = toCopyableAsset(child);
        if (asset && asset.project !== targetProject) {
          out.push({ path: [...path, key], url: child });
          next[key] = null;
          continue;
        }
        next[key] = child;
        continue;
      }
      next[key] = withholdInto(child, targetProject, [...path, key], out);
    }
    return next;
  }
  return value;
}

/**
 * 粘贴入 store **之前**调用：把节点数据里指向别的项目的媒体 URL 全部置空并记下位置。
 * 返回的数据可以直接进 store / 落库——里面不再有任何源项目地址。没有外项目媒体时
 * `withheld` 为空、数据原样（不加标记）。
 */
export function withholdForeignAssetUrls(
  data: CanvasNodeData,
  targetProject: string,
): { data: CanvasNodeData; withheld: WithheldAssetRef[] } {
  const withheld: WithheldAssetRef[] = [];
  const stripped = withholdInto(data, targetProject, [], withheld) as Record<string, unknown>;
  if (withheld.length === 0) {
    return { data, withheld };
  }
  stripped[ASSET_MIGRATION_KEY] = 'copying';
  return { data: stripped as unknown as CanvasNodeData, withheld };
}

function readAtPath(root: unknown, path: Array<string | number>): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  return cursor;
}

/** 纯函数：在 `root` 的 `path` 处写入 `value`，沿途容器浅拷贝，返回新根。 */
function writeAtPath(root: unknown, path: Array<string | number>, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const next = [...root];
    next[head as number] = writeAtPath(root[head as number], rest, value);
    return next;
  }
  const source = (root && typeof root === 'object' ? root : {}) as Record<string, unknown>;
  return { ...source, [head]: writeAtPath(source[head as string], rest, value) };
}

// ——— 进行中的迁移登记：占位渲染靠它区分「正在拷」和「标记还在、任务已不在」———
// 后者出现在刷新（store 里是落库的 copying 标记，任务随页面一起没了）或迁移意外抛错，
// 一律按失败占位渲染，不让转圈永远转下去。本 PR 不做跨刷新续传。
const inFlightNodeIds = new Set<string>();
const inFlightListeners = new Set<() => void>();

function setInFlight(nodeIds: readonly string[], active: boolean): void {
  let changed = false;
  for (const nodeId of nodeIds) {
    if (active ? !inFlightNodeIds.has(nodeId) : inFlightNodeIds.has(nodeId)) {
      changed = true;
    }
    if (active) {
      inFlightNodeIds.add(nodeId);
    } else {
      inFlightNodeIds.delete(nodeId);
    }
  }
  if (!changed) {
    return;
  }
  for (const listener of [...inFlightListeners]) {
    listener();
  }
}

export function isAssetMigrationInFlight(nodeId: string): boolean {
  return inFlightNodeIds.has(nodeId);
}

/** 供 useSyncExternalStore：登记表变化时通知，快照用 `isAssetMigrationInFlight`。 */
export function subscribeAssetMigrations(listener: () => void): () => void {
  inFlightListeners.add(listener);
  return () => {
    inFlightListeners.delete(listener);
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * 分批让后端拷贝，返回 归一化路径 → 新 URL 的映射，以及失败的归一化路径集合。
 * 一批整体失败（网络 / 5xx）时，这一批的所有路径都算失败，其它批不受影响。
 */
async function copyAssetsInBatches(
  targetProject: string,
  sources: string[],
): Promise<{ mapping: Map<string, string>; failed: Set<string> }> {
  const mapping = new Map<string, string>();
  const failed = new Set<string>();
  for (const batch of chunk(sources, COPY_BATCH_SIZE)) {
    try {
      const result = await copyFreezoneAssets(targetProject, batch);
      for (const [source, newUrl] of Object.entries(result.mapping ?? {})) {
        if (typeof newUrl === 'string' && newUrl && newUrl !== source) {
          mapping.set(source, newUrl);
        }
      }
      for (const item of result.failed ?? []) {
        failed.add(item.source);
        console.warn('[cross-project-assets] copy failed, field stays empty', item);
      }
    } catch (error) {
      for (const source of batch) {
        failed.add(source);
      }
      console.warn('[cross-project-assets] copy request failed, fields stay empty', {
        count: batch.length,
        error,
      });
    }
  }
  return { mapping, failed };
}

export interface PastedNodeForMigration {
  id: string;
  /** `withholdForeignAssetUrls` 记下的、待填回的媒体位置。 */
  withheld: WithheldAssetRef[];
}

export interface AssetMigrationSummary {
  /** 成功拷进目标项目的去重资产数。 */
  migrated: number;
  /** 拷贝失败的去重资产数（对应字段保持为空）。 */
  failed: number;
  /** 至少有一处媒体没拷成、被标记为 `'failed'` 的节点 id。 */
  failedNodeIds: string[];
}

/**
 * 把一组刚粘贴进来的节点里被扣下的媒体资产拷到 `targetProject`，再填回节点。
 *
 * 分三步：(1) 从各节点记下的位置收集去重的资产 URL；(2) 分批交给后端拷贝，得到旧→新
 * URL 映射；(3) 用 `getLiveNodeData` 读取**当前**节点数据（而非粘贴时的快照），只把新
 * 地址写到「仍然为空」的原位置——拷贝期间用户往那格自己放了东西就不覆盖；节点若已被
 * 删除 / 切走项目则跳过。全部填回的节点摘掉 `assetMigration`，有失败的标成 `'failed'`。
 * 相同 URL 只拷一次。
 */
export async function migratePastedNodeAssets(params: {
  nodes: PastedNodeForMigration[];
  targetProject: string;
  getLiveNodeData: (id: string) => CanvasNodeData | null;
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void;
}): Promise<AssetMigrationSummary> {
  const { nodes, targetProject, getLiveNodeData, updateNodeData } = params;
  const pending = nodes.filter((node) => node.withheld.length > 0);
  if (pending.length === 0) {
    return { migrated: 0, failed: 0, failedNodeIds: [] };
  }
  const nodeIds = pending.map((node) => node.id);
  setInFlight(nodeIds, true);
  try {
    return await runMigration(pending, targetProject, getLiveNodeData, updateNodeData);
  } catch (error) {
    // 意外抛错（不该发生：单批失败已在 copyAssetsInBatches 里吞掉）：把还挂着
    // copying 的节点统一标成失败，别让占位永远转圈。
    console.warn('[cross-project-assets] migration crashed, marking nodes failed', error);
    const failedNodeIds: string[] = [];
    const failedUrls = new Set<string>();
    for (const { id, withheld } of pending) {
      for (const { url } of withheld) {
        failedUrls.add(url);
      }
      const liveData = getLiveNodeData(id);
      if (!liveData) {
        continue;
      }
      failedNodeIds.push(id);
      if (readAssetMigrationState(liveData) === 'copying') {
        updateNodeData(id, { [ASSET_MIGRATION_KEY]: 'failed' } as Partial<CanvasNodeData>);
      }
    }
    return { migrated: 0, failed: failedUrls.size, failedNodeIds };
  } finally {
    setInFlight(nodeIds, false);
  }
}

async function runMigration(
  nodes: PastedNodeForMigration[],
  targetProject: string,
  getLiveNodeData: (id: string) => CanvasNodeData | null,
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void,
): Promise<AssetMigrationSummary> {
  // 1. 收集去重的资产 URL（原始字符串 → 归一化路径）。
  const rawToSource = new Map<string, string>();
  for (const { withheld } of nodes) {
    for (const { url } of withheld) {
      if (rawToSource.has(url)) {
        continue;
      }
      const asset = toCopyableAsset(url);
      if (asset && asset.project !== targetProject) {
        rawToSource.set(url, asset.source);
      }
    }
  }

  // 2. 分批让后端拷贝，构建 原始字符串 → 新 URL 的映射。
  const sources = [...new Set(rawToSource.values())];
  const { mapping, failed: failedSources } =
    sources.length > 0
      ? await copyAssetsInBatches(targetProject, sources)
      : { mapping: new Map<string, string>(), failed: new Set<string>() };
  const urlMap = new Map<string, string>();
  for (const [raw, source] of rawToSource) {
    const newUrl = mapping.get(source);
    if (newUrl) {
      urlMap.set(raw, newUrl);
    }
  }

  // 3. 只往「当前」节点数据里仍为空的原位置填新地址；节点已不在则跳过。
  const failedNodeIds: string[] = [];
  for (const { id, withheld } of nodes) {
    const liveData = getLiveNodeData(id);
    if (!liveData) {
      continue;
    }
    let nextData: unknown = liveData;
    let nodeFailed = false;
    for (const { path, url } of withheld) {
      const newUrl = urlMap.get(url);
      if (!newUrl) {
        nodeFailed = true;
        continue;
      }
      if (readAtPath(nextData, path) !== null) {
        // 用户在拷贝期间自己填了这一格（或改动了结构），不覆盖。
        continue;
      }
      nextData = writeAtPath(nextData, path, newUrl);
    }
    const previousData = liveData as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(nextData as Record<string, unknown>)) {
      if (value !== previousData[key]) {
        patch[key] = value;
      }
    }
    const nextState: AssetMigrationState | undefined = nodeFailed ? 'failed' : undefined;
    if (previousData[ASSET_MIGRATION_KEY] !== nextState) {
      patch[ASSET_MIGRATION_KEY] = nextState;
    }
    if (nodeFailed) {
      failedNodeIds.push(id);
    }
    if (Object.keys(patch).length > 0) {
      updateNodeData(id, patch as Partial<CanvasNodeData>);
    }
  }

  return { migrated: mapping.size, failed: failedSources.size, failedNodeIds };
}
