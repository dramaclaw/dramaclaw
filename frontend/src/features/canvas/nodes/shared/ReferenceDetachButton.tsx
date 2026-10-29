// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { KeyboardEvent, MouseEvent } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ReferenceDetachButtonProps {
  nodeId: string;
  onDetach: (nodeId: string) => void;
  className?: string;
  /** Legacy button chips need a span; new media groups use a native sibling button. */
  as?: 'span' | 'button';
}

export function ReferenceDetachButton({ nodeId, onDetach, className, as = 'span' }: ReferenceDetachButtonProps) {
  const { t } = useTranslation();
  const props = {
    title: t('canvas.reference.detach'),
    'aria-label': t('canvas.reference.detach'),
    className: className ?? 'nodrag absolute right-1 top-1 z-10 hidden h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white shadow-sm ring-1 ring-white/15 transition-colors hover:bg-red-500 group-hover:flex group-focus-within:flex',
    onMouseDown: (event: MouseEvent<HTMLElement>) => { event.preventDefault(); event.stopPropagation(); },
    onClick: (event: MouseEvent<HTMLElement>) => { event.preventDefault(); event.stopPropagation(); onDetach(nodeId); },
    onDoubleClick: (event: MouseEvent<HTMLElement>) => { event.preventDefault(); event.stopPropagation(); },
    onKeyDown: as === 'span' ? (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation(); onDetach(nodeId);
      }
    } : undefined,
  };
  const icon = <X className="h-3 w-3" strokeWidth={2.5} />;
  return as === 'button'
    ? <button type="button" {...props}>{icon}</button>
    : <span role="button" tabIndex={0} {...props}>{icon}</span>;
}
