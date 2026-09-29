// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from 'react';
import { groupColorLabel } from '@/features/canvas/domain/groupColors';

/** Group names stay readable when the workflow is zoomed out; media titles scale with their cards. */
export function GroupNodeHeader({ title, color, onTitleChange }: {
  title: string;
  color?: string | null;
  onTitleChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const badge = groupColorLabel(color);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  const commit = () => {
    const next = draft.trim();
    if (!cancelled.current && next && next !== title) onTitleChange(next);
    setEditing(false);
  };
  return (
    <div
      className="absolute left-0 z-10 w-max origin-bottom-left"
      style={{
        bottom: 'calc(100% + 8px)',
        transform: 'scale(calc(1 / var(--st-canvas-zoom, 1)))',
        maxWidth: 'calc(100% * var(--st-canvas-zoom, 1))',
      }}
    >
      <div
        className={`flex max-w-full items-center font-normal ${badge ? 'h-6 px-1.5 text-[12px] leading-[18px]' : 'text-[13px] leading-[1.55]'}`}
        style={{ borderRadius: badge ? 6 : undefined, backgroundColor: badge, color: badge ? 'var(--group-label-colored-text)' : 'var(--group-label-text)' }}
      >
        {editing ? (
          <input
            ref={input}
            value={draft}
            aria-label={title}
            className="nodrag nopan min-w-0 bg-transparent outline-none"
            style={{ width: `${Math.max(4, Array.from(draft).length + 1)}em`, maxWidth: '100%' }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                cancelled.current = true;
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            title={title}
            className="min-w-0 cursor-text select-none truncate"
            onDoubleClick={(event) => {
              event.stopPropagation();
              cancelled.current = false;
              setDraft(title);
              setEditing(true);
            }}
          >{title}</span>
        )}
      </div>
    </div>
  );
}
