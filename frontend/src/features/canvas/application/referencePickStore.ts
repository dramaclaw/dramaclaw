// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「参考」拾取态。独立成一个轻量 store，理由同 snapAlignStore：订阅它的组件
 * （顶部 banner、每个节点上的拾取遮罩）不该因为画布内容变动而重渲染。
 *
 * 规则与候选计算在 [[referencePick]]。
 */
import type { Viewport } from '@xyflow/react';
import { create } from 'zustand';

import type { CanvasNodeType } from '../domain/canvasNodes';
import type { ReferencePickCandidate } from './referencePick';

export interface ReferencePickRequest {
  /** 发起 ＋参考 的那个节点，最终所有参考边都连到它。 */
  targetNodeId: string;
  targetNodeType: CanvasNodeType;
  /** 进入拾取态时的视口，「返回节点」按原样恢复。 */
  originViewport: Viewport | null;
  /** 进入拾取态那一刻算好的可选节点快照：nodeId → 候选信息。 */
  candidates: Map<string, ReferencePickCandidate>;
  /** 同一刻算好的「连得上但种类不收」的节点：nodeId → 不能选的原因文案。 */
  rejections: Map<string, string>;
}

interface ReferencePickState {
  request: ReferencePickRequest | null;
  start: (request: ReferencePickRequest) => void;
  stop: () => void;
}

export const useReferencePickStore = create<ReferencePickState>((set) => ({
  request: null,
  start: (request) => set({ request }),
  stop: () => set({ request: null }),
}));
