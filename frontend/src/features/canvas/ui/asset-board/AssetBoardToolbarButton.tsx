// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Loader2, type LucideIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

/**
 * 详情工具条按钮的统一样式（图片/视频/文本三条工具条 + 第二批图片操作区共用）。
 *
 * 圆角收到 rounded-[6px]：本项目 --radius=1rem，rounded-md 折合 14px，在 ~29px 高
 * 的按钮上几乎等于全胶囊，和徽标 chip（rounded-full）糊在一起；收小一档区分。
 */
export const DETAIL_TOOLBAR_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-[6px] border border-white/10 bg-white/5 px-2.5 py-1.5 text-[12px] text-white/75 transition-colors hover:bg-white/10 hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-45';

/**
 * 详情工具条按钮。独立成文件（而非留在 AssetBoardDetailToolbar）以打断
 * 工具条 ↔ 第二批操作区（AssetBoardImageEditMenu）的循环 import。
 */
export function DetailToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  busy = false,
  title,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** 进行中：图标换 spinner 并禁用（生成类操作的最简进行中反馈）。 */
  busy?: boolean;
  title?: string;
  trailing?: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      title={title ?? label}
      disabled={disabled || busy}
      onClick={onClick}
      className={DETAIL_TOOLBAR_BUTTON_CLASS}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
      {trailing}
    </button>
  );
}
