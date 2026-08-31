// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

import { createDefaultScene, type PrevizScene } from './domain/scene';

/** 场景是纯数值 JSON，整份快照很便宜；50 步够覆盖一次连续编辑。 */
export const PREVIZ_HISTORY_LIMIT = 50;

interface PrevizStoreState {
  scene: PrevizScene;
  /** 相对上次写回 node.data 是否有未落盘改动。 */
  dirty: boolean;
  past: PrevizScene[];
  future: PrevizScene[];
  /** 打开编辑器时灌入初始场景，同时清空历史——上一次会话的 undo 不该跨节点串。 */
  loadScene: (scene: PrevizScene) => void;
  /** 场景改动的唯一入口：压历史、清 redo、置脏。 */
  applyScene: (next: PrevizScene) => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
}

export const usePrevizStore = create<PrevizStoreState>((set, get) => ({
  scene: createDefaultScene(),
  dirty: false,
  past: [],
  future: [],

  loadScene: (scene) => set({ scene, dirty: false, past: [], future: [] }),

  applyScene: (next) => {
    const { scene, past } = get();
    set({
      scene: next,
      dirty: true,
      past: [...past, scene].slice(-PREVIZ_HISTORY_LIMIT),
      future: [],
    });
  },

  undo: () => {
    const { past, scene, future } = get();
    const previous = past[past.length - 1];
    if (!previous) return;
    set({ scene: previous, past: past.slice(0, -1), future: [scene, ...future], dirty: true });
  },

  redo: () => {
    const { future, scene, past } = get();
    const [next, ...rest] = future;
    if (!next) return;
    set({
      scene: next,
      future: rest,
      past: [...past, scene].slice(-PREVIZ_HISTORY_LIMIT),
      dirty: true,
    });
  },

  markSaved: () => set({ dirty: false }),
}));
