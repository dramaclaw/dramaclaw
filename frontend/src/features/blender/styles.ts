// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 配对页两张卡片的表面。
 *
 * shadcn `Card` 默认是 `bg-card`（#1f2c34，带青调），压在近黑的页面底上又亮又脏。
 * DESIGN.md 的产品界面 Level 1 表面是中性的 `surface-panel` 配 `ui-border-soft` 细边、
 * 16px 面板圆角、不加投影；这里直接引 index.css 的变量，亮色主题跟着变量一起切。
 */
export const BLENDER_PAGE_CARD =
  "rounded-[var(--ui-radius-xl)] border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] ring-0";
