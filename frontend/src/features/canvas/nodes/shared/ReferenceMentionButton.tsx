// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { AtSign } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NODE_REFERENCE_MEDIA_MENTION_CLASS, NODE_REFERENCE_MEDIA_MENTION_BADGE_CLASS } from '@/features/canvas/ui/nodeControlStyles';

interface ReferenceMentionButtonProps {
  mentionName: string;
  onInsert: () => void;
  onJump?: () => void;
  className?: string;
  appearance?: 'overlay' | 'badge';
}

/** Native buttons preserve keyboard activation; double-click may jump to the source. */
export function ReferenceMentionButton({ mentionName, onInsert, onJump, className, appearance = 'overlay' }: ReferenceMentionButtonProps) {
  const { t } = useTranslation();
  const label = t('canvas.reference.mention', { name: mentionName });
  return <button type="button" aria-label={label} title={label}
    className={className ?? (appearance === 'badge' ? NODE_REFERENCE_MEDIA_MENTION_BADGE_CLASS : NODE_REFERENCE_MEDIA_MENTION_CLASS)}
    onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
    onClick={event => {
      event.preventDefault(); event.stopPropagation();
      if (event.detail > 1) return;
      onInsert();
    }}
    onDoubleClick={event => {
      event.preventDefault(); event.stopPropagation();
      onJump?.();
    }}>
    <AtSign className={appearance === 'badge' ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'} strokeWidth={2} />
  </button>;
}
