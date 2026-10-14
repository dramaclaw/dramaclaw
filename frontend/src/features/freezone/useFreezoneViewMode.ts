// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

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
 * 顶栏视图菜单与保活画布共享同一份状态，进入视图的附加行为由画布宿主处理。
 */
const useViewModeStore = create<{
  mode: FreezoneViewMode;
  setMode: (mode: FreezoneViewMode) => void;
}>((set) => ({
  mode: readStoredViewMode(),
  setMode: (mode) => {
    writeStoredViewMode(mode);
    set({ mode });
  },
}));

export function useFreezoneViewMode(): [FreezoneViewMode, (mode: FreezoneViewMode) => void] {
  const mode = useViewModeStore((state) => state.mode);
  const setMode = useViewModeStore((state) => state.setMode);
  return [mode, setMode];
}

/** Project-folder entry resets both the live view and its saved preference. */
export function resetFreezoneViewMode(): void {
  useViewModeStore.getState().setMode('workflow');
}
