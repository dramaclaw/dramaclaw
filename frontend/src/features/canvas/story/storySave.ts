/**
 * 互动影游存档:把 inkjs 运行态(`story.state.toJson()`)和故事指纹持久化到 localStorage,
 * 按「画布 + 故事组」隔离。所有读写吞掉异常 → 隐私模式/配额超限时优雅降级为「不存档」。
 *
 * key 前缀 `st.story.` 受 reset-region-state 的 SWEEP_PREFIXES 覆盖,区域切换会清存档。
 */
import { parseExploration, type StoryExploration } from './storyExploration';

export function storySaveKey(canvasId: string, groupId: string): string {
  return `st.story.save.${canvasId}.${groupId}`;
}

/** 检测 Ink 内容变更，防止旧存档中已生成的选项/指针覆盖新故事。不是安全校验。 */
export function storySaveFingerprint(storyJson: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < storyJson.length; index += 1) {
    hash = Math.imul(hash ^ storyJson.charCodeAt(index), 0x01000193);
  }
  return `${storyJson.length}:${(hash >>> 0).toString(16)}`;
}

/** 不传指纹时读取原始存档供存在性检查；传入时只返回兼容的 Ink 运行态。 */
export function readStorySave(key: string, fingerprint?: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || fingerprint === undefined) return raw;
    const saved = JSON.parse(raw);
    return saved?.version === 1 && saved.storyFingerprint === fingerprint && typeof saved.inkState === 'string'
      ? saved.inkState
      : null;
  } catch {
    return null;
  }
}

export function readExplorationSave(key: string, fingerprint: string, nodeIds: Set<string>): StoryExploration {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    return parseExploration(saved?.version === 1 && saved.storyFingerprint === fingerprint ? saved.exploration : null, nodeIds);
  } catch {
    return parseExploration(null, nodeIds);
  }
}

export function writeStorySave(key: string, json: string, fingerprint?: string, exploration?: StoryExploration): void {
  try {
    localStorage.setItem(key, fingerprint === undefined ? json : JSON.stringify({
      version: 1,
      storyFingerprint: fingerprint,
      inkState: json,
      ...(exploration ? { exploration } : {}),
    }));
  } catch {
    // 隐私模式 / 配额超限:静默降级为不存档。
  }
}

export function clearStorySave(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上。
  }
}
