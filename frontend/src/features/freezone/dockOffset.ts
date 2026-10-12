// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CSSProperties } from "react";

/**
 * 画布 agent 抽屉的「全局让位」协议。
 *
 * 抽屉本身是通高的 fixed 浮层（对标 liblib：打开时从屏幕最顶一直铺到最底，压在
 * 顶栏之上），所以它没法再靠 flex 把别人挤窄——只能反过来广播「右边被我占了多少」，
 * 由那些横贯整屏的全局条自己往左收：
 * - 顶栏（含右上角设置/通知/伙伴/算力/头像那一组，以及虾画·虾集导航）
 * - 底部任务状态条 / 展开的任务面板
 *
 * 变量挂在 `<html>` 上而不是走 React context：拖宽抽屉时每帧只改这一个字符串，
 * 顶栏就能跟着手走，不必让整棵组件树重渲染。抽屉没开、或不在自由画布页时变量
 * 不存在，`var(..., 0px)` 兜底 → 所有宿主保持原样。
 */
export const FREEZONE_DOCK_WIDTH_VAR = "--freezone-dock-width";

/**
 * 让位动画时长。开合抽屉时是 300ms（与抽屉自身缓动同款），拖宽时抽屉会把它压成
 * 0ms——否则每帧都排一段 300ms 缓动，顶栏边缘会橡皮筋一样吊在手后面。
 */
export const FREEZONE_DOCK_TRANSITION_VAR = "--freezone-dock-transition";

/** 只让位、不接管过渡：留给自己已有 transition 的宿主（任务面板的展开动画）。 */
export const FREEZONE_DOCK_OFFSET_STYLE: CSSProperties = {
  marginRight: `var(${FREEZONE_DOCK_WIDTH_VAR}, 0px)`,
};

/**
 * 让位 + 跟抽屉同款缓动。`transitionProperty` 里额外带上 background-color，是因为
 * 内联样式会整条盖掉宿主 class 上的 `transition-colors`（底部状态条的 hover 变色
 * 靠它）。
 */
export const FREEZONE_DOCK_OFFSET_ANIMATED_STYLE: CSSProperties = {
  ...FREEZONE_DOCK_OFFSET_STYLE,
  transitionProperty: "margin, background-color",
  transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
  transitionDuration: `var(${FREEZONE_DOCK_TRANSITION_VAR}, 300ms)`,
};

/**
 * 抽屉宽度的 CSS 表达式：与抽屉自己的 `maxWidth` 用同一条夹取，保证「窗口太窄被
 * 压回去」时顶栏让出的位置不会比抽屉实际宽。夹取交给 CSS 做，换窗口尺寸时不需要
 * 任何 JS 参与。
 */
export function freezoneDockOffsetCss(dockWidth: number, minContentWidth: number): string {
  return `min(${dockWidth}px, calc(100vw - ${minContentWidth}px))`;
}
