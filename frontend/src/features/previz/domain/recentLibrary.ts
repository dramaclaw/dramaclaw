// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 模型库「最近使用」：最近放进场景的条目 id，新的在前。
 *
 * 存在本机 localStorage 而不是场景或后端：这是个人手边的快捷方式，不是作品的一部分，
 * 换台电脑从空开始无妨。读写失败（隐私模式、存储满了）一律当没有，不影响放置本身。
 */
const STORAGE_KEY = 'previz.library.recent';
export const PREVIZ_RECENT_LIMIT = 12;

export function readRecentLibraryIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string').slice(0, PREVIZ_RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function rememberRecentLibraryId(id: string): void {
  const next = [id, ...readRecentLibraryIds().filter((existing) => existing !== id)].slice(
    0,
    PREVIZ_RECENT_LIMIT,
  );
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存不下就不记，见文件头。
  }
}
