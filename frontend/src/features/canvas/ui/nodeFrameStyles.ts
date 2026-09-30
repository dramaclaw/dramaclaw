// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
interface CanvasNodeFrameOptions {
  selected?: boolean;
  mainline?: boolean;
  dashed?: boolean;
}

export const CANVAS_NODE_PANEL_SURFACE_CLASS = "bg-[#242426]/95";
export const CANVAS_NODE_INPUT_SURFACE_CLASS = "bg-[#282828]";
export const CANVAS_NODE_INPUT_BODY_FRAME_CLASS =
  "border-white/12 shadow-[0_8px_20px_rgba(0,0,0,0.24)] hover:border-white/18 focus-within:border-white/24";
export const CANVAS_NODE_INPUT_FRAME_CLASS =
  "border-white/8 shadow-[0_10px_24px_rgba(0,0,0,0.28)] hover:border-white/14 focus-within:border-white/18";
export const CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS =
  "border-white/26 shadow-[0_10px_24px_rgba(0,0,0,0.28)]";
export const CANVAS_NODE_INPUT_PLACEHOLDER_CLASS =
  "canvas-node-input-placeholder placeholder:text-[var(--canvas-node-input-placeholder)]";

// Chrome for a node's floating operation area — the prompt / controls panel that
// floats below (or, when expanded, replaces) a selected node. Single source of
// truth so every node's 操作区 shares the text node's neutral surface + border
// (CANVAS_NODE_INPUT_SURFACE_CLASS + CANVAS_NODE_INPUT_FRAME_CLASS) instead of the
// bluish `bg-surface-dark/95`. Already includes the `border` width/style keyword,
// so apply it as a drop-in replacement for `border ... bg-surface-dark/95 shadow-*`.
export const CANVAS_NODE_OPS_PANEL_CLASS = `canvas-node-transient-ui border ${CANVAS_NODE_INPUT_SURFACE_CLASS} ${CANVAS_NODE_INPUT_FRAME_CLASS}`;
export const CANVAS_NODE_TOOLBAR_SURFACE_CLASS = CANVAS_NODE_OPS_PANEL_CLASS;
// 圆角 12px 而不是 rounded-full：这些工具条有 36~40px 高，全胶囊的两头圆得过分
// （用户反馈「圆角太大了」，裁剪 / 旋转 / 视频详情三处同一个观感问题）。
// 12px 落在 --radius-sm 上，读起来是「圆角矩形」而不是药丸。
export const CANVAS_NODE_TOOLBAR_PILL_CLASS =
  `rounded-[12px] ${CANVAS_NODE_TOOLBAR_SURFACE_CLASS} p-1.5`;
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
  return mainline
    ? `${borderStyle} ${transition} border-white/16 hover:border-white/24`
    : `${borderStyle} ${transition} border-white/10 hover:border-white/18`;
}
