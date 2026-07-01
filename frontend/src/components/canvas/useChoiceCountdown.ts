import { useEffect, useRef, useState } from 'react';

/** 倒计时刷新间隔(ms),够顺滑又不过密。 */
const TICK_MS = 50;

export interface ChoiceCountdown {
  /** 剩余毫秒(0 = 已超时)。 */
  remainingMs: number;
  /** 剩余比例 0..1(1 = 满,0 = 超时)。不限时/未激活时为 1。 */
  fraction: number;
}

/**
 * 限时选项倒计时。`active && seconds>0` 时从满倒数到 0,归零触发一次 `onTimeout`。
 * `active`/`seconds` 变化即重置;卸载清理。纯计时逻辑,与播放器 UI 解耦,便于单测。
 */
export function useChoiceCountdown({
  seconds,
  active,
  onTimeout,
}: {
  seconds: number | null;
  active: boolean;
  onTimeout: () => void;
}): ChoiceCountdown {
  const totalMs = seconds != null && seconds > 0 ? seconds * 1000 : 0;
  const [remainingMs, setRemainingMs] = useState(totalMs);

  // 用 ref 持有最新 onTimeout,避免它每次变化都重启计时器。
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  });

  useEffect(() => {
    if (!active || totalMs <= 0) {
      setRemainingMs(totalMs);
      return;
    }
    const start = Date.now();
    setRemainingMs(totalMs);
    let fired = false;
    const id = setInterval(() => {
      const rem = Math.max(0, totalMs - (Date.now() - start));
      setRemainingMs(rem);
      if (rem <= 0 && !fired) {
        fired = true;
        clearInterval(id);
        onTimeoutRef.current();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active, totalMs]);

  const fraction = totalMs > 0 ? remainingMs / totalMs : 1;
  return { remainingMs, fraction };
}
