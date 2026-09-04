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
 * 这里把粘贴进来的节点里的媒体 URL 交给后端 `freezone/assets/copy`，由后端在服务端
 * 把文件拷进目标项目（OSS 部署下是 CopyObject，字节不经过浏览器），再把节点数据里
 * 的 URL 静默改写成目标项目的新地址。单条失败则保留原 URL。
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

interface RemapResult {
  value: unknown;
  changed: boolean;
}

/**
 * 收集一份节点数据里所有「可迁移」的媒体资产（key 以 Url 结尾、值是别的项目的同源
 * 静态资产）。返回 原始字符串 → 归一化后的同源路径。
 */
function collectAssetUrls(value: unknown, targetProject: string, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAssetUrls(item, targetProject, out);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string' && /url$/i.test(key)) {
        if (out.has(child)) {
          continue;
        }
        const asset = toCopyableAsset(child);
        // 本来就属于目标项目的 URL 不用动。
        if (asset && asset.project !== targetProject) {
          out.set(child, asset.source);
        }
        continue;
      }
      collectAssetUrls(child, targetProject, out);
    }
  }
}

/** 纯函数：把节点数据里命中 `urlMap` 的资产 URL 换成新地址，未命中的原样保留。 */
function remapAssetUrls(value: unknown, urlMap: Map<string, string>): RemapResult {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = remapAssetUrls(item, urlMap);
      if (result.changed) {
        changed = true;
      }
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }

  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = { ...source };
    for (const [key, child] of Object.entries(source)) {
      if (typeof child === 'string' && /url$/i.test(key)) {
        const mapped = urlMap.get(child);
        if (mapped !== undefined && mapped !== child) {
          next[key] = mapped;
          changed = true;
        }
        continue;
      }
      const result = remapAssetUrls(child, urlMap);
      if (result.changed) {
        next[key] = result.value;
        changed = true;
      }
    }
    return { value: changed ? next : value, changed };
  }

  return { value, changed: false };
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
        console.warn('[cross-project-assets] copy failed, keeping original', item);
      }
    } catch (error) {
      for (const source of batch) {
        failed.add(source);
      }
      console.warn('[cross-project-assets] copy request failed, keeping originals', {
        count: batch.length,
        error,
      });
    }
  }
  return { mapping, failed };
}

export interface PastedNodeForMigration {
  id: string;
  data: CanvasNodeData;
}

export interface AssetMigrationSummary {
  /** 成功迁移的去重资产数。 */
  migrated: number;
  /** 迁移失败、保留原 URL 的去重资产数。 */
  failed: number;
}

/**
 * 把一组刚粘贴进来的节点里的媒体资产迁移到 `targetProject`。
 *
 * 分三步：(1) 从粘贴快照里收集去重的资产 URL；(2) 分批交给后端拷贝，得到旧→新 URL
 * 映射；(3) 用 `getLiveNodeData` 读取**当前**节点数据（而非粘贴时的快照）做纯改写——
 * 这样拷贝期间用户对节点的编辑（改 URL、往画册加卡片等）不会被旧快照覆盖；节点若已
 * 被删除 / 切走项目则跳过。相同 URL 只拷一次。
 */
export async function migratePastedNodeAssets(params: {
  nodes: PastedNodeForMigration[];
  targetProject: string;
  getLiveNodeData: (id: string) => CanvasNodeData | null;
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void;
}): Promise<AssetMigrationSummary> {
  const { nodes, targetProject, getLiveNodeData, updateNodeData } = params;

  // 1. 从快照收集去重的可迁移资产 URL（原始字符串 → 归一化路径）。
  const rawToSource = new Map<string, string>();
  for (const { data } of nodes) {
    collectAssetUrls(data, targetProject, rawToSource);
  }
  if (rawToSource.size === 0) {
    return { migrated: 0, failed: 0 };
  }

  // 2. 分批让后端拷贝，构建 原始字符串 → 新 URL 的映射。
  const sources = [...new Set(rawToSource.values())];
  const { mapping, failed: failedSources } = await copyAssetsInBatches(targetProject, sources);
  const urlMap = new Map<string, string>();
  for (const [raw, source] of rawToSource) {
    const newUrl = mapping.get(source);
    if (newUrl) {
      urlMap.set(raw, newUrl);
    }
  }
  const migrated = mapping.size;
  const failed = failedSources.size;
  if (urlMap.size === 0) {
    return { migrated, failed };
  }

  // 3. 用「当前」节点数据做纯改写，避免覆盖拷贝期间用户的并发编辑；节点已不在则跳过。
  for (const { id } of nodes) {
    const liveData = getLiveNodeData(id);
    if (!liveData) {
      continue;
    }
    const result = remapAssetUrls(liveData, urlMap);
    if (!result.changed) {
      continue;
    }
    const nextData = result.value as Record<string, unknown>;
    const previousData = liveData as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(nextData)) {
      if (nextData[key] !== previousData[key]) {
        patch[key] = nextData[key];
      }
    }
    if (Object.keys(patch).length > 0) {
      updateNodeData(id, patch as Partial<CanvasNodeData>);
    }
  }

  return { migrated, failed };
}
