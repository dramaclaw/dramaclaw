import { useEffect, useRef, useState } from 'react';

/** Pausing a menu preserves the remaining budget, including confirmation and placeholder timers. */
export function useStoryTimer({ delayMs, active, paused = false, resetKey, onElapsed }: {
  delayMs: number;
  active: boolean;
  paused?: boolean;
  resetKey?: string | number | null;
  onElapsed: () => void;
}) {
  const remaining = useRef(delayMs);
  const fired = useRef(false);
  const callback = useRef(onElapsed);
  callback.current = onElapsed;
  const [remainingMs, setRemainingMs] = useState(delayMs);
  useEffect(() => {
    remaining.current = delayMs;
    fired.current = false;
    setRemainingMs(delayMs);
  }, [active, delayMs, resetKey]);
  useEffect(() => {
    if (!active || paused || fired.current) return;
    const budget = remaining.current;
    const started = Date.now();
    const update = () => {
      remaining.current = Math.max(0, budget - (Date.now() - started));
      setRemainingMs(remaining.current);
    };
    const tick = window.setInterval(update, 50);
    const timer = window.setTimeout(() => {
      update();
      fired.current = true;
      window.clearInterval(tick);
      callback.current();
    }, budget);
    return () => {
      remaining.current = Math.max(0, budget - (Date.now() - started));
      window.clearInterval(tick);
      window.clearTimeout(timer);
    };
  }, [active, delayMs, paused, resetKey]);
  return remainingMs;
}
