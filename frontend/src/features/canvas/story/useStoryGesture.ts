import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { emitStoryEvent } from './storyEvents';

interface StoryGestureOptions {
  trigger: 'click' | 'hold';
  duration: number;
  disabled?: boolean;
  onSelect: () => void;
  eventContext: Record<string, unknown>;
  emitEvents: boolean;
}

/** Shared pointer/keyboard lifecycle. Completion stays visible until the next hold.
 * Release, blur and disable cancel an active hold once; unmount silently disposes it.
 */
export function useStoryGesture({ trigger, duration, disabled, onSelect, eventContext, emitEvents }: StoryGestureOptions) {
  const [progress, setProgress] = useState(0);
  const [completed, setCompleted] = useState(false);
  const latest = useRef({ onSelect, eventContext, emitEvents });
  useEffect(() => {
    latest.current = { onSelect, eventContext, emitEvents };
  });
  const emit = useCallback((type: string) => {
    if (latest.current.emitEvents) emitStoryEvent(type, latest.current.eventContext);
  }, []);
  const active = useRef<{ x: number; y: number; start: number; pointerId?: number } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const suppressClick = useRef(false);
  const stop = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  }, []);
  const cancel = useCallback(() => {
    if (active.current) emit('hold_cancel');
    active.current = null;
    stop();
    setProgress(0);
  }, [emit, stop]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      stop();
      active.current = null;
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [trigger, duration, cancel, stop]);
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);
  const begin = (x: number, y: number, pointerId?: number) => {
    if (disabled || trigger !== 'hold' || active.current) return;
    suppressClick.current = false;
    setCompleted(false);
    active.current = { x, y, start: performance.now(), pointerId };
    emit('hold_start');
    timer.current = setInterval(() => {
      if (!active.current) return;
      const fraction = Math.min(1, (performance.now() - active.current.start) / duration);
      setProgress(fraction);
      if (fraction === 1) {
        setCompleted(true);
        stop();
        active.current = null;
        suppressClick.current = true;
        emit('hold_complete');
        latest.current.onSelect();
      }
    }, 16);
  };
  const handlers: ButtonHTMLAttributes<HTMLButtonElement> = {
    onContextMenu: (event) => {
      if (trigger === 'hold') event.preventDefault();
    },
    onPointerDown: (event) => {
      if (event.button !== 0 || trigger === 'click' || disabled) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      begin(event.clientX, event.clientY, event.pointerId);
    },
    onPointerMove: (event) => {
      const value = active.current;
      if (!value || value.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - value.x, event.clientY - value.y) > 12) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    onBlur: cancel,
    onKeyDown: (event) => {
      if (trigger !== 'hold' || ![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (!event.repeat) begin(0, 0);
    },
    onKeyUp: (event) => {
      if (trigger !== 'hold' || ![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      cancel();
    },
    onClick: () => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      if (!disabled && trigger === 'click') onSelect();
    },
  };
  return { progress, completed, handlers };
}
