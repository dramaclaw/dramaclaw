// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

/**
 * 画布指针工具。
 * - `move`：默认模式，左键框选 / 拖节点，中键或空格拖动平移画布。
 * - `hand`：抓手，左键按住直接拖动画布；节点不可拖、不可框选（拖到节点上也是平移）。
 */
export type CanvasTool = 'move' | 'hand';

interface CanvasToolState {
  tool: CanvasTool;
  setTool: (tool: CanvasTool) => void;
}

/**
 * 刻意不持久化：抓手是「临时换个手势」，不是偏好。上次退出时忘在抓手上，下次进来
 * 点不动任何节点，用户只会以为画布坏了。刷新一律回到移动工具。
 *
 * 单独一个轻量 store（和对齐吸附 / 触控板平移开关同构），订阅它的工具条不会因画布
 * 节点变动而重渲染。
 */
export const useCanvasToolStore = create<CanvasToolState>((set) => ({
  tool: 'move',
  setTool: (tool) => set({ tool }),
}));
