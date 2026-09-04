// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ReferenceDetachButtonProps {
  /** 上游节点 id（连线的 source） */
  nodeId: string;
  /** 取消引用回调 */
  onDetach: (nodeId: string) => void;
  /** 额外的定位/样式类名（默认贴在右上角） */
  className?: string;
}

/**
 * 引用素材缩略图上的「取消引用」按钮。
 *
 * 使用 <span role="button">（而非 <button>），以便嵌套在本身就是
 * <button> 的引用 chip 内部而不产生非法的 button 嵌套。
 *
 * 约定：父容器需带 `group relative`，按钮默认 `hidden`，hover 时
 * 通过 `group-hover:flex` 显示。
 */
export function ReferenceDetachButton({ nodeId, onDetach, className }: ReferenceDetachButtonProps) {
  const { t } = useTranslation();
  return (
    <span
      role="button"
      tabIndex={-1}
      title={t('canvas.reference.detach')}
      className={
        className ??
        'nodrag absolute right-1 top-1 z-10 hidden h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white shadow-sm ring-1 ring-white/15 transition-colors hover:bg-red-500 group-hover:flex'
      }
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDetach(nodeId);
      }}
    >
      <X className="h-3 w-3" strokeWidth={2.5} />
    </span>
  );
}
