// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useState } from 'react';

/** 画布视图模式：工作流（React Flow 画布）或 故事板（AssetBoard 三栏投影）。 */
export type FreezoneViewMode = 'workflow' | 'board';

// 沿用 lib/url-params.ts 的 "supertale.freezone." localStorage 命名空间。
// 视图模式刻意不进 URL（对标 liblib：asset_board_mode 存 localStorage），
// 避免触碰 tanstack 路由节流队列（见 no-raw-window-history 约定）。
export const FREEZONE_VIEW_MODE_KEY = 'supertale.freezone.viewMode';

export function readStoredViewMode(): FreezoneViewMode {
  try {
    return window.localStorage.getItem(FREEZONE_VIEW_MODE_KEY) === 'board' ? 'board' : 'workflow';
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
    return 'workflow';
  }
}

export function writeStoredViewMode(mode: FreezoneViewMode): void {
  try {
    window.localStorage.setItem(FREEZONE_VIEW_MODE_KEY, mode);
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

/**
 * 画布视图模式 state + localStorage 写穿。
 * 单调用点约定：目前仅 FreezoneShell 使用；若第二个组件需要读写此状态，
 * 请升级为共享 store（参照 edgeVisibilityStore 的 Zustand 模式）避免多副本失步。
 */
export function useFreezoneViewMode(): [FreezoneViewMode, (mode: FreezoneViewMode) => void] {
  const [mode, setMode] = useState<FreezoneViewMode>(readStoredViewMode);
  const update = useCallback((next: FreezoneViewMode) => {
    setMode(next);
    writeStoredViewMode(next);
  }, []);
  return [mode, update];
}
