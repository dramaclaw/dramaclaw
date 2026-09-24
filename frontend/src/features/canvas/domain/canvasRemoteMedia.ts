// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「这条素材没能本地保存」的原因码 → 界面文案。
 *
 * 为什么要把原因显示出来：远端素材在画布上看着完全正常（图能显示），但它
 *   - 喂不进本地模型（生成/编辑要的是本地可读的文件）
 *   - 不能当作参考图
 *   - LibTV 一撤下就变裂图
 * 只说「未本地保存」而不说为什么，用户没法判断是该重试、换素材，还是改配置。
 */
import type { CanvasNode, RemoteMediaRef } from '@/features/canvas/domain/canvasNodes';

/** 后端 liblib_assets 给出的原因码 → i18n key。未知码回落到通用文案。 */
export const REMOTE_MEDIA_REASON_KEYS: Record<string, string> = {
  // 采集阶段（地址本身就不能安全下载）
  internal_host: 'canvas.remoteMedia.reason.internalHost',
  not_https: 'canvas.remoteMedia.reason.notHttps',
  has_credentials: 'canvas.remoteMedia.reason.hasCredentials',
  bad_url: 'canvas.remoteMedia.reason.badUrl',
  unsupported_file_type: 'canvas.remoteMedia.reason.unsupportedFileType',
  // 配额
  too_many_assets: 'canvas.remoteMedia.reason.tooManyAssets',
  total_size_limit: 'canvas.remoteMedia.reason.totalSizeLimit',
  // 下载阶段（沿用后端 LiblibImportError 的 code）
  liblib_media_too_large: 'canvas.remoteMedia.reason.mediaTooLarge',
  liblib_media_empty: 'canvas.remoteMedia.reason.mediaEmpty',
  liblib_media_type_invalid: 'canvas.remoteMedia.reason.mediaTypeInvalid',
  liblib_media_unavailable: 'canvas.remoteMedia.reason.mediaUnavailable',
};

export function remoteMediaReasonKey(reason: string | null | undefined): string {
  return (reason && REMOTE_MEDIA_REASON_KEYS[reason]) || 'canvas.remoteMedia.reason.unknown';
}

/** 读取节点上的远端素材标记。没有标记返回空数组。 */
export function readRemoteMediaRefs(data: unknown): RemoteMediaRef[] {
  const record = data as { liblibImport?: { remoteMedia?: unknown } } | null | undefined;
  const refs = record?.liblibImport?.remoteMedia;
  if (!Array.isArray(refs)) return [];
  return refs.filter(
    (ref): ref is RemoteMediaRef =>
      Boolean(ref) && typeof ref === 'object' && typeof (ref as RemoteMediaRef).url === 'string',
  );
}

export function nodeHasRemoteMedia(node: CanvasNode | null | undefined): boolean {
  return readRemoteMediaRefs(node?.data).length > 0;
}

/**
 * 只认 key 以 `url` 结尾的字符串（imageUrl / previewImageUrl / posterUrl / sourceUrl …）。
 *
 * 不做「扫所有字符串里的 http」是有意的：prompt 里经常粘着参考链接，那些不是素材，
 * 拿去下载纯属浪费，还会在结果里堆一堆 unsupported_file_type 的噪音。
 */
function isMediaUrlKey(key: string): boolean {
  return /url$/i.test(key);
}

function isRemoteUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function walkMediaUrls(value: unknown, visit: (url: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkMediaUrls(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // `liblibImport` 是元数据:`sourceUrl` 记的是素材原本在 LibTV 的位置(溯源用,
    // 永不参与显示),`remoteMedia` 是标记本身。把它算进来会在一张**已经全部本地化**
    // 的画布上误报「N 个素材未本地化」——64c5bb59 那张就是 92 条全是 sourceUrl。
    if (key === 'liblibImport') continue;
    if (isMediaUrlKey(key) && isRemoteUrl(child)) visit(child);
    else walkMediaUrls(child, visit);
  }
}

/** 画布上所有仍指向远端的素材地址（去重）。 */
export function collectRemoteMediaUrls(nodes: readonly CanvasNode[]): string[] {
  const urls = new Set<string>();
  for (const node of nodes) walkMediaUrls(node.data, (url) => urls.add(url));
  return [...urls];
}

/** 把 data 里命中 assetMap 的远端地址换成本地地址。返回 null 表示这个节点没变化。 */
function rewriteUrls(value: unknown, assetMap: Record<string, string>): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = rewriteUrls(item, assetMap);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== 'object') return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // 同上:`liblibImport.sourceUrl` 是溯源,本地化之后也要留着指向 LibTV 原址,
    // 不能被改写成本地路径。标记本身由 applyLocalizedAssets 另行重算。
    if (key === 'liblibImport') {
      next[key] = child;
      continue;
    }
    if (isMediaUrlKey(key) && isRemoteUrl(child) && assetMap[child]) {
      next[key] = assetMap[child];
      changed = true;
      continue;
    }
    const rewritten = rewriteUrls(child, assetMap);
    if (rewritten !== child) changed = true;
    next[key] = rewritten;
  }
  return changed ? next : value;
}

/**
 * 本地化之后重算一个节点的数据：换掉已落地的地址，并按最新结果重写「网络素材」标记。
 *
 * 返回 null 表示这个节点没有任何变化，调用方据此跳过一次 store 写入。
 */
export function applyLocalizedAssets(
  data: unknown,
  assetMap: Record<string, string>,
  reasons: Map<string, string>,
): Record<string, unknown> | null {
  const rewritten = rewriteUrls(data, assetMap);
  const remaining: RemoteMediaRef[] = [];
  const seen = new Set<string>();
  walkMediaUrls(rewritten, (url) => {
    if (seen.has(url)) return;
    seen.add(url);
    remaining.push({ url, reason: reasons.get(url) ?? 'unknown' });
  });
  const previous = readRemoteMediaRefs(rewritten);
  const unchangedData = rewritten === data;
  const unchangedMarks =
    previous.length === remaining.length
    && previous.every((ref, index) => ref.url === remaining[index]?.url && ref.reason === remaining[index]?.reason);
  if (unchangedData && unchangedMarks) return null;
  const record = rewritten as Record<string, unknown>;
  const liblibImport = record.liblibImport as Record<string, unknown> | undefined;
  if (!liblibImport) return record;
  return {
    ...record,
    liblibImport: remaining.length > 0
      ? { ...liblibImport, remoteMedia: remaining }
      : Object.fromEntries(Object.entries(liblibImport).filter(([key]) => key !== 'remoteMedia')),
  };
}

/** 这个节点上还有没有指向远端的显示素材。用于「一键本地化」的显隐判断——
 *  它订阅这个布尔量而不是 nodes，避免拖动节点时每帧深走全部节点数据。 */
export function nodeHasRemoteMediaUrl(node: CanvasNode): boolean {
  let found = false;
  walkMediaUrls(node.data, () => { found = true; });
  return found;
}
