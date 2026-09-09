// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { AtSign } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { NODE_REFERENCE_MEDIA_MENTION_CLASS } from '@/features/canvas/ui/nodeControlStyles';

interface ReferenceMentionButtonProps {
  /** 这条引用在提示词里的名字，如「图片1」；只用于 title。 */
  mentionName: string;
  onInsert: () => void;
  className?: string;
}

/**
 * 引用素材缩略图右下角的 @ 按钮：一键把这条引用插进下方提示词输入框。
 *
 * 在这之前要引用第 N 张图，用户得先自己数清楚它排第几、再手打 `@图片N`——数错了
 * 后端就按错的那张生成。这里直接把 chip 和它的编号绑定，点一下插入正确的 mention。
 *
 * 和 [[ReferenceDetachButton]] 一样用 <span role="button">：引用 chip 本身就是
 * <button>，嵌套 <button> 是非法结构。
 */
export function ReferenceMentionButton({
  mentionName,
  onInsert,
  className,
}: ReferenceMentionButtonProps) {
  const { t } = useTranslation();
  return (
    <span
      role="button"
      tabIndex={-1}
      title={t('canvas.reference.mention', { name: mentionName })}
      className={className ?? NODE_REFERENCE_MEDIA_MENTION_CLASS}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        // 双击 chip 是「跳到画布上那个节点」，别让落在 @ 上的第二下也触发跳转。
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onInsert();
      }}
    >
      <AtSign className="h-2.5 w-2.5" strokeWidth={2.5} />
    </span>
  );
}
