// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「跳过去看一眼，再跳回来」的退路。
 *
 * 双击提示词栏里的引用素材会把视口甩到那个上游节点上——这一步很有用，但跳完之后
 * 用户往往已经不知道自己原来在哪，也没法一键回到刚才正在写提示词的节点。所以跳之前
 * 把视口存下来，画布底部浮一条「返回节点」。
 *
 * 独立成一个轻量 store，理由同 [[referencePickStore]]：订阅它的只有底部那条提示，
 * 不该因为画布内容变动而重渲染。
 */
import type { Viewport } from '@xyflow/react';
import { create } from 'zustand';

import { useCanvasStore } from '@/stores/canvasStore';

export interface ViewportReturnRequest {
  /** 跳走之前的视口，「返回节点」按原样恢复。 */
  originViewport: Viewport;
  /** 跳走时正在编辑的那个节点；回来时连它一起重新选中，面板才会跟着打开。 */
  originNodeId: string;
}

interface ViewportReturnState {
  request: ViewportReturnRequest | null;
  start: (request: ViewportReturnRequest) => void;
  stop: () => void;
}

export const useViewportReturnStore = create<ViewportReturnState>((set) => ({
  request: null,
  start: (request) => set({ request }),
  stop: () => set((state) => (state.request === null ? state : { request: null })),
}));

/**
 * 跳到某个被引用的上游节点，并留下回到 `originNodeId` 的退路。
 *
 * 聚焦本身复用 canvasStore 的 pendingFocusNodeId（Canvas 那边统一做 setCenter，
 * 组内成员的绝对坐标换算也在那里），这里只负责记住「从哪来的」。
 */
export function focusReferenceNode(referenceNodeId: string, originNodeId: string): void {
  const canvas = useCanvasStore.getState();
  // 存副本：currentViewport 是 store 里的活对象，直接存引用的话下一次视口更新
  // 可能把「原视口」也一起改掉，返回就回到了错的地方。
  const { x, y, zoom } = canvas.currentViewport;
  useViewportReturnStore.getState().start({
    originViewport: { x, y, zoom },
    originNodeId,
  });
  canvas.requestFocusNode(referenceNodeId);
}
