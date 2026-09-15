// SPDX-License-Identifier: Elastic-2.0
export const TOOLBAR_BUTTON_RADIUS_CLASS = "rounded-[12px]";
// 扁平菜单项：去掉独立边框与胶囊背景，融入工具栏整条；仅靠 hover 高亮区分。
export const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  "!border-transparent !bg-transparent text-text-dark hover:!bg-[rgba(255,255,255,0.075)] focus:!border-transparent focus:!bg-transparent focus:!shadow-none focus-visible:!outline-none focus-visible:!ring-0 data-[state=open]:!border-transparent data-[state=open]:!shadow-none";
export const TOOLBAR_TEXT_BUTTON_CLASS = `h-9 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-3 text-sm ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`;
export const TOOLBAR_MENU_CONTENT_CLASS =
  "z-[120] border-white/10 bg-[#242426]/50 text-text-dark shadow-none backdrop-blur-3xl";
export const TOOLBAR_MENU_ITEM_CLASS =
  "gap-2 rounded-[10px] text-text-dark focus:bg-[rgba(255,255,255,0.075)] focus:text-text-dark";
