// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 预演台外壳共用的几段样式。视觉语言是纯中性灰阶：外壳 neutral-950、面板 neutral-900、
 * 浮层 neutral-800，分隔线 white/10，按下态只提亮不上色。彩色只留给真正有语义的东西
 * （坐标轴的 XYZ、录制的红点、监看直播的蓝灯），这样它们一出现就能被看见。
 *
 * 用 Tailwind 的 neutral 色阶而不是写 hex：编辑器根节点挂了 `.dark`，亮色主题下打开
 * 预演台也恒为暗色外壳。
 */

/** 悬浮在三维视口上的实心面板（左上工具栏）。 */
export const PREVIZ_FLOAT_PANEL = "border border-white/10 bg-neutral-800 shadow-lg shadow-black/30";

/** 悬浮在视口上的胶囊簇（右上显示模式、画笔参数）：半透明底，压在浅色模型上也看得清。 */
export const PREVIZ_FLOAT_PILL = "rounded-full border border-white/10 bg-neutral-800/80 backdrop-blur-tap";

/** 浮层里图标按钮的静止态。 */
export const PREVIZ_ICON_ITEM =
  "rounded-lg text-neutral-300 transition-colors duration-150 hover:bg-white/10 hover:text-neutral-50 focus-visible:border-white/30 focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:outline-none";

/** 按下态：只提亮、不上色。 */
export const PREVIZ_ICON_ON = "bg-white/10 text-neutral-50 hover:bg-white/[0.14] hover:text-neutral-50";

/** 描边胶囊按钮（聚焦、四视图、顶栏的截图与录制）。 */
export const PREVIZ_OUTLINE_PILL =
  "h-6 gap-1 rounded-full border border-white/20 px-2.5 text-[12px] font-medium text-neutral-200 transition-colors duration-150 hover:bg-white/10 hover:text-neutral-50 focus-visible:border-white/30 focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:outline-none";

/** 角标：贴在按钮右上角外沿的小胶囊，写快捷键字母。 */
export const PREVIZ_KEYCAP_CORNER = "absolute -right-1 -top-1";

/** 面板里分段用的细线。 */
export const PREVIZ_HAIRLINE = "bg-white/10";
