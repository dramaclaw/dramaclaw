/**
 * 互动影游存档:把 inkjs 运行态(`story.state.toJson()`)持久化到 localStorage,
 * 按「画布 + 故事组」隔离。所有读写吞掉异常 → 隐私模式/配额超限时优雅降级为「不存档」。
 *
 * key 前缀 `st.story.` 受 reset-region-state 的 SWEEP_PREFIXES 覆盖,区域切换会清存档。
 */

export function storySaveKey(canvasId: string, groupId: string): string {
  return `st.story.save.${canvasId}.${groupId}`;
}

export function readStorySave(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorySave(key: string, json: string): void {
  try {
    localStorage.setItem(key, json);
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
