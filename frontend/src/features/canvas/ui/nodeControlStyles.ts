// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export const NODE_CONTROL_CHIP_CLASS =
  '!h-7 !gap-1.5 !rounded !border-transparent !bg-transparent !px-1 !text-xs !shadow-none text-text-dark/90 hover:!bg-transparent hover:!text-white';

export const NODE_CONTROL_MODEL_CHIP_CLASS = '!w-auto !justify-start !shrink-0';

export const NODE_CONTROL_PARAMS_CHIP_CLASS = '!w-auto !justify-start !shrink-0';

export const NODE_CONTROL_PRIMARY_BUTTON_CLASS =
  '!h-6 !rounded-md !px-2 !text-[11px] !gap-1 border border-transparent';

export const NODE_CONTROL_ICON_CLASS = 'h-3 w-3';

export const NODE_TEXT_CONTROL_TRIGGER_CLASS =
  'nodrag inline-flex h-7 items-center gap-1.5 rounded px-1 text-xs font-medium text-text-dark/88 transition-colors hover:text-text-dark';

export const NODE_TEXT_CONTROL_ICON_CLASS = 'h-3.5 w-3.5 text-text-muted/90';

export const NODE_CONTEXT_CONTROL_TRIGGER_CLASS =
  'nodrag inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 text-[11px] font-medium text-text-dark transition-colors hover:border-white/20 hover:bg-white/[0.07]';

export const NODE_REFERENCE_MEDIA_CHIP_CLASS =
  'group/refmedia relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-white/10 bg-white/[0.04] transition-colors hover:border-white/30';

export const NODE_REFERENCE_MEDIA_DETACH_CLASS =
  'nodrag absolute right-1 top-1 z-10 hidden h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white shadow-sm ring-1 ring-white/15 transition-colors hover:bg-red-500 group-hover/refmedia:flex';

// 引用缩略图右下角的 @ 按钮。与 DETACH 不同，它常驻显示（不是 hover 才出）：
// 「能把这条引用 @ 进提示词」是个需要被发现的能力，藏起来等于没有。
export const NODE_REFERENCE_MEDIA_MENTION_CLASS =
  'nodrag absolute bottom-1 right-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-black/65 text-white/85 shadow-sm ring-1 ring-white/15 transition-colors hover:bg-[rgb(var(--accent-rgb))] hover:text-white';

export const NODE_INLINE_ERROR_MESSAGE_CLASS =
  'min-w-0 max-w-full overflow-hidden rounded-[8px] border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-100 whitespace-pre-wrap break-words [overflow-wrap:anywhere]';

export const NODE_INLINE_ICON_BUTTON_CLASS =
  'nodrag inline-flex h-7 w-7 items-center justify-center rounded-md text-text-dark/72 transition-colors hover:bg-white/[0.08] hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-45';

export const NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS = 'bg-white/[0.12] text-text-dark';

export const NODE_FLOATING_PANEL_SURFACE_CLASS =
  'canvas-node-transient-ui rounded-[10px] border border-white/[0.12] bg-[#282828]/96 shadow-[0_14px_34px_rgba(0,0,0,0.42)] backdrop-blur-md';

export const NODE_COUNT_POPOVER_CLASS =
  `nodrag nowheel absolute bottom-full right-0 z-50 mb-2 w-[88px] overflow-hidden p-1 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;

export const NODE_CREDIT_PILL_FLAT_CLASS = 'rounded-none bg-transparent px-0';

export const NODE_GENERATE_BUTTON_BASE_CLASS =
  'nodrag inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors';

export const NODE_GENERATE_BUTTON_ENABLED_CLASS = 'bg-white text-bg-dark hover:bg-white/90';

export const NODE_GENERATE_BUTTON_DISABLED_CLASS = 'cursor-not-allowed bg-white/5 text-text-muted/40';
