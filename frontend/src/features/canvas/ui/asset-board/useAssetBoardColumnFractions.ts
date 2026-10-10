// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useState } from 'react';

/** 三栏（文本 / 图片 / 视频）宽度占比，恒归一化到和为 1。 */
export type ColumnFractions = readonly [number, number, number];

// 沿用 lib/url-params.ts 与 useFreezoneViewMode 的 "supertale.freezone." localStorage
// 命名空间。栏宽比例刻意不进 URL（对标 liblib：asset_board_bottom_layout_v1 存
// localStorage），避免触碰 tanstack 路由节流队列（见 no-raw-window-history 约定）。
export const ASSET_BOARD_COLUMN_FRACTIONS_KEY = 'supertale.freezone.assetBoardColumnFractions';

/** 缺失 / 脏值时的回落：三栏等宽。 */
export const DEFAULT_COLUMN_FRACTIONS: ColumnFractions = [1 / 3, 1 / 3, 1 / 3];

/**
 * 读取持久化占比。任何异常（无 window / 非 JSON / 结构或数值不合法）都回落等宽。
 * 合法值必须是长度 3、每项为正有限数的数组；读出后重新归一化，容忍历史写入的
 * 非归一化值。
 */
export function readStoredFractions(): ColumnFractions {
  try {
    const raw = window.localStorage.getItem(ASSET_BOARD_COLUMN_FRACTIONS_KEY);
    if (!raw) return DEFAULT_COLUMN_FRACTIONS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 3) return DEFAULT_COLUMN_FRACTIONS;
    const nums = parsed.map((n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : NaN));
    if (nums.some((n) => Number.isNaN(n))) return DEFAULT_COLUMN_FRACTIONS;
    const sum = nums[0] + nums[1] + nums[2];
    if (!Number.isFinite(sum) || sum <= 0) return DEFAULT_COLUMN_FRACTIONS;
    return [nums[0] / sum, nums[1] / sum, nums[2] / sum];
  } catch {
    // localStorage can be unavailable in restricted browser contexts / SSR.
    return DEFAULT_COLUMN_FRACTIONS;
  }
}

export function writeStoredFractions(fractions: ColumnFractions): void {
  try {
    window.localStorage.setItem(
      ASSET_BOARD_COLUMN_FRACTIONS_KEY,
      JSON.stringify([fractions[0], fractions[1], fractions[2]]),
    );
  } catch {
    // localStorage can be unavailable in restricted browser contexts / SSR.
  }
}

/**
 * 纯函数：把一次分隔条拖拽（像素位移）换算成新的三栏占比。
 * @param start        拖拽开始时的占比（和为 1）。
 * @param handleIndex  分隔条序号：0 = 文本/图片之间；1 = 图片/视频之间。
 * @param deltaPx      指针相对起点的水平位移（px），向右为正。
 * @param width        容器总宽（px），来自 getBoundingClientRect。
 * @param minPx        单栏最小宽度（px），拖到底不塌陷。
 *
 * 只在相邻两栏之间转移份额（其余栏不动，故和恒为 1）。两栏都不得低于 minFrac；
 * 若容器过窄以致无可用空间（upper < lower），退化为把 i 栏钉在最小宽度。
 */
export function applyColumnResize(
  start: ColumnFractions,
  handleIndex: 0 | 1,
  deltaPx: number,
  width: number,
  minPx: number,
): ColumnFractions {
  const i = handleIndex;
  const j = handleIndex + 1;
  const minFrac = width > 0 ? minPx / width : 0;
  const rawDelta = width > 0 ? deltaPx / width : 0;
  // new_i = start[i] + d >= minFrac  → d >= minFrac - start[i]（lower）
  // new_j = start[j] - d >= minFrac  → d <= start[j] - minFrac（upper）
  const lower = minFrac - start[i];
  const upper = start[j] - minFrac;
  const delta = Math.min(Math.max(rawDelta, lower), Math.max(upper, lower));
  const result: [number, number, number] = [start[0], start[1], start[2]];
  // 极窄容器（width < ~3×minPx）退化分支里 upper < lower，钳出的 delta 可能让相邻栏
  // 算成负 fraction；虽被 CSS minWidth + 读校验兜底，这里出口再夹一次非负更干净。
  result[i] = Math.max(0, start[i] + delta);
  result[j] = Math.max(0, start[j] - delta);
  return result;
}

/**
 * 三栏占比 state + localStorage 写穿。
 * - setFractions：拖拽过程中的实时更新（只改 state，不落库）。
 * - commitFractions：松手落库（改 state 并写 localStorage）。
 *
 * 单调用点约定：目前仅 AssetBoardColumns 使用；组件在进/退详情态时挂载/卸载，
 * 靠重挂载从 localStorage 恢复，故无需跨副本同步。若第二处需要读写，请升级为
 * 共享 store（参照 useFreezoneViewMode 的同款说明）。
 */
export function useAssetBoardColumnFractions(): {
  fractions: ColumnFractions;
  setFractions: (next: ColumnFractions) => void;
  commitFractions: (next: ColumnFractions) => void;
} {
  const [fractions, setFractionsState] = useState<ColumnFractions>(readStoredFractions);
  const setFractions = useCallback((next: ColumnFractions) => setFractionsState(next), []);
  const commitFractions = useCallback((next: ColumnFractions) => {
    setFractionsState(next);
    writeStoredFractions(next);
  }, []);
  return { fractions, setFractions, commitFractions };
}
