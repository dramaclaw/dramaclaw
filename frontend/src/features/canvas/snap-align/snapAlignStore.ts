// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

// 吸附对齐：节点拖动时显示局部智能引导线，指示当前节点和目标节点的同边、
// 中线或相邻边关系。
// 状态独立成一个轻量 store，避免和 canvas 内容 store 混在一起，订阅它的
// 组件（按钮、引导线 overlay）也不会因 canvas 节点变动而重渲染。

const STORAGE_KEY = 'canvas.snapAlign.enabled';
const STORAGE_VERSION_KEY = 'canvas.snapAlign.preferenceVersion';
const STORAGE_VERSION = '2';

function readPersistedEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    // v2 是本次可用性重构：旧版默认关闭且可能残留 `0`，会让新功能完全不进入
    // 计算链路。首次升级统一开启一次；之后仍尊重用户在 v2 中的明确选择。
    if (window.localStorage.getItem(STORAGE_VERSION_KEY) !== STORAGE_VERSION) {
      window.localStorage.setItem(STORAGE_VERSION_KEY, STORAGE_VERSION);
      window.localStorage.setItem(STORAGE_KEY, '1');
      return true;
    }
    const persisted = window.localStorage.getItem(STORAGE_KEY);
    return persisted === null ? true : persisted === '1';
  } catch {
    return true;
  }
}

function persistEnabled(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_VERSION_KEY, STORAGE_VERSION);
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // localStorage 写不进去就算了，下次进来从默认值开始。
  }
}

export interface SnapAlignGuideSegment {
  /** Flow 坐标下的固定轴坐标：竖线为 x，横线为 y。 */
  coordinate: number;
  /** Flow 坐标下沿另一轴的线段起止位置。 */
  start: number;
  end: number;
  targetNodeId: string;
  relation: 'align' | 'adjacent';
}

export interface SnapAlignGuides {
  /** Flow 坐标下的局部垂直引导线。 */
  vertical: SnapAlignGuideSegment[];
  /** Flow 坐标下的局部水平引导线。 */
  horizontal: SnapAlignGuideSegment[];
}

const EMPTY_GUIDES: SnapAlignGuides = { vertical: [], horizontal: [] };

interface SnapAlignState {
  enabled: boolean;
  guides: SnapAlignGuides;
  toggle: () => void;
  setGuides: (guides: SnapAlignGuides) => void;
  clearGuides: () => void;
}

export const useSnapAlignStore = create<SnapAlignState>((set, get) => ({
  enabled: readPersistedEnabled(),
  guides: EMPTY_GUIDES,
  toggle: () => {
    const next = !get().enabled;
    persistEnabled(next);
    set({ enabled: next, guides: EMPTY_GUIDES });
  },
  setGuides: (guides) => set({ guides }),
  clearGuides: () => {
    const cur = get().guides;
    if (cur.vertical.length === 0 && cur.horizontal.length === 0) return;
    set({ guides: EMPTY_GUIDES });
  },
}));
