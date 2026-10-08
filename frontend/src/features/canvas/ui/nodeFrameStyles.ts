// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
interface CanvasNodeFrameOptions {
  selected?: boolean;
  mainline?: boolean;
  dashed?: boolean;
}

/*
 * 卡面与描边对齐 liblib.tv（实测计算值）：
 *   媒体卡  bg #171717  border #363636
 *   文本/音频卡 bg #171717  border #525252
 *   卡片一律无投影（liblib 的 box-shadow 是 none）
 * 白色透明描边叠在 #171717 上的换算：白 13% ≈ #353535，白 25% ≈ #525252。
 * 用透明度而不是写死灰值，浅色主题才能共用同一套类。
 */
export const CANVAS_NODE_PANEL_SURFACE_CLASS = "bg-[#171717]";
export const CANVAS_NODE_INPUT_SURFACE_CLASS = "bg-[#171717]";
/**
 * 浮层（操作面板 / 工具条）保持原来的 #282828：它悬在卡片之上，跟卡面同色就分不出
 * 层级了。liblib 同样是浮层比卡面亮一档。
 */
export const CANVAS_NODE_OPS_SURFACE_CLASS = "bg-[#282828]";
export const CANVAS_NODE_INPUT_BODY_FRAME_CLASS =
  "border-white/25 hover:border-white/32 focus-within:border-white/38";
export const CANVAS_NODE_INPUT_FRAME_CLASS =
  "border-white/8 shadow-[0_10px_24px_rgba(0,0,0,0.28)] hover:border-white/14 focus-within:border-white/18";
export const CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS = "border-white/45";
export const CANVAS_NODE_INPUT_PLACEHOLDER_CLASS =
  "canvas-node-input-placeholder placeholder:text-[var(--canvas-node-input-placeholder)]";

// Chrome for a node's floating operation area — the prompt / controls panel that
// floats below (or, when expanded, replaces) a selected node. Single source of
// truth so every node's 操作区 shares the text node's neutral surface + border
// (CANVAS_NODE_INPUT_SURFACE_CLASS + CANVAS_NODE_INPUT_FRAME_CLASS) instead of the
// bluish `bg-surface-dark/95`. Already includes the `border` width/style keyword,
// so apply it as a drop-in replacement for `border ... bg-surface-dark/95 shadow-*`.
export const CANVAS_NODE_OPS_PANEL_CLASS = `canvas-node-transient-ui border ${CANVAS_NODE_OPS_SURFACE_CLASS} ${CANVAS_NODE_INPUT_FRAME_CLASS}`;
export const CANVAS_NODE_TOOLBAR_SURFACE_CLASS = CANVAS_NODE_OPS_PANEL_CLASS;
export const CANVAS_NODE_TOOLBAR_PILL_CLASS =
  `rounded-full ${CANVAS_NODE_TOOLBAR_SURFACE_CLASS} p-1.5`;
export const CANVAS_NODE_TOOLBAR_CARD_CLASS =
  `rounded-2xl ${CANVAS_NODE_TOOLBAR_SURFACE_CLASS}`;

export function canvasNodeFrameClass({
  selected = false,
  mainline = false,
  dashed = false,
}: CanvasNodeFrameOptions): string {
  const borderStyle = dashed ? "border-dashed" : "border-solid";
  const transition = "transition-colors duration-200 ease-out";
  if (selected) {
    return `${borderStyle} ${transition} border-white/34`;
  }
  // 未选中的媒体卡：白 13% 叠在 #171717 上 ≈ #353535，即 liblib 的 #363636。
  return mainline
    ? `${borderStyle} ${transition} border-white/20 hover:border-white/28`
    : `${borderStyle} ${transition} border-white/13 hover:border-white/20`;
}
