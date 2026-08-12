// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

/**
 * 「从画布选择」拾取模式。
 *
 * 某个节点（目前是逐帧拉片节点）需要引用画布上已有的素材时，进入拾取模式：
 * 画布顶部挂一条提示条，候选节点上浮出「选择 xxx」的覆盖层，点中即回填。
 *
 * 刻意独立于 `canvasStore`：这是纯瞬态的 UI 状态，不该混进会被持久化 /
 * 进历史栈的画布数据里（写进 canvasStore 会让每次进出拾取模式都脏一次画布）。
 */

/** 拾取模式接受的素材类型。目前只有视频，留成联合类型方便后续扩展。 */
export type CanvasPickKind = 'video';

export interface CanvasPickRequest {
  /** 发起拾取的节点 id —— 「返回节点」按钮聚焦它，选中结果也回填给它。 */
  requesterNodeId: string;
  kind: CanvasPickKind;
}

interface CanvasPickState {
  request: CanvasPickRequest | null;
  startPick: (request: CanvasPickRequest) => void;
  cancelPick: () => void;
  /** 只取消属于该节点的拾取（节点被删除时清场，避免误伤别人的拾取）。 */
  cancelPickFor: (requesterNodeId: string) => void;
}

export const useCanvasPickStore = create<CanvasPickState>((set, get) => ({
  request: null,
  startPick: (request) => set({ request }),
  cancelPick: () => set({ request: null }),
  cancelPickFor: (requesterNodeId) => {
    if (get().request?.requesterNodeId === requesterNodeId) {
      set({ request: null });
    }
  },
}));

/** 当前是否正在为「该类型」拾取素材（节点渲染覆盖层时用）。 */
export function useIsPickingKind(kind: CanvasPickKind): boolean {
  return useCanvasPickStore((state) => state.request?.kind === kind);
}
