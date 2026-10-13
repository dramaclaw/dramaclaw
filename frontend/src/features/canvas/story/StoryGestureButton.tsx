import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import type { StoryChoiceInteraction } from './storyTypes';
import { useStoryGesture } from './useStoryGesture';
import styles from './StoryGestureButton.module.css';

/** Pointer and keyboard share one cancellable hold. */
export function StoryGestureButton({ interaction, onSelect, eventContext, emitEvents = true, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  interaction?: StoryChoiceInteraction;
  onSelect: () => void;
  eventContext: Record<string, unknown>;
  emitEvents?: boolean;
}) {
  const trigger = interaction?.trigger ?? 'click';
  const duration = interaction?.holdMs ?? 1000;
  const isTarget = interaction?.uiStyle === 'tag' && interaction.presentation === 'object-anchor';
  const { progress, completed, handlers } = useStoryGesture({
    trigger, duration, disabled: props.disabled, onSelect, eventContext, emitEvents,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [borderRadius, setBorderRadius] = useState(14);
  useEffect(() => {
    const button = buttonRef.current;
    if (!button || trigger !== 'hold' || isTarget) return;
    const update = () => {
      const radius = getComputedStyle(button).borderTopLeftRadius;
      const value = Number.parseFloat(radius);
      if (Number.isFinite(value)) setBorderRadius(Math.max(0, (radius.endsWith('%') ? value * button.clientWidth / 100 : value) - 1));
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(button);
    return () => observer?.disconnect();
  }, [trigger, isTarget, props.className]);
  return <button {...props} ref={buttonRef}
    style={{ ...(interaction?.presentation === 'overlay' || !interaction?.presentation ? { position: 'relative' as const } : {}), ...props.style, touchAction: 'manipulation' }}
    {...handlers}>
    {trigger === 'hold' && (
      <span aria-hidden="true" className={isTarget
        ? 'pointer-events-none absolute left-1/2 top-1/2 z-[3] flex size-[62px] -translate-x-1/2 -translate-y-1/2 items-center justify-center text-white'
        : 'pointer-events-none absolute inset-0 z-[3] text-white [border-radius:inherit]'}>
        {isTarget ? <svg data-hold-progress="true" viewBox="0 0 62 62" className="h-full w-full" fill="none">
          <circle data-hold-arc="true" cx="31" cy="31" r="30" pathLength="1"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeDasharray="1" strokeDashoffset={completed ? 0 : 1 - progress}
            opacity={progress > 0 || completed ? 1 : 0} transform="rotate(-90 31 31)" />
        </svg> : <svg data-hold-progress="true" className="absolute inset-0 h-full w-full overflow-visible" fill="none">
          <rect data-hold-arc="true" data-hold-perimeter="true" x="1" y="1" rx={borderRadius} pathLength="1"
            style={{ width: 'calc(100% - 2px)', height: 'calc(100% - 2px)' }}
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke"
            strokeDasharray="1" strokeDashoffset={completed ? 0 : 1 - progress}
            opacity={progress > 0 || completed ? 1 : 0} />
        </svg>}
        {isTarget && <>
          <span data-tech-target="true" data-completed={completed} className={styles.outer} />
          <span className={styles.middle} />
          <span className={styles.inner} />
        </>}
      </span>
    )}
    {children}
  </button>;
}
