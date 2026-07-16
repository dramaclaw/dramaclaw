// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

// 连线可见性：仅控制画布是否**渲染**节点之间的连线。连线数据始终保留在
// canvas store 里（隐藏时给 ReactFlow 的边打 `hidden` 标记，不动真实 edges），
// 所以隐藏纯粹是视觉层面的，切回来连线原样还在、持久化/导出也不受影响。
// 独立成一个轻量 store，避免和 canvas 内容 store 混在一起——订阅它的按钮与
// Canvas 派生逻辑不会因节点/边的内容变动而额外重渲染。

const STORAGE_KEY = 'canvas.edges.hidden';

function readPersistedHidden(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistHidden(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // localStorage 写不进去就算了，下次进来从默认值开始。
  }
}

interface EdgeVisibilityState {
  hidden: boolean;
  toggle: () => void;
}

export const useEdgeVisibilityStore = create<EdgeVisibilityState>((set, get) => ({
  hidden: readPersistedHidden(),
  toggle: () => {
    const next = !get().hidden;
    persistHidden(next);
    set({ hidden: next });
  },
}));
