import { useStoryTimer } from '@/features/canvas/story/useStoryTimer';

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
  paused = false,
  resetKey,
  onTimeout,
}: {
  seconds: number | null;
  active: boolean;
  paused?: boolean;
  resetKey?: string | number | null;
  onTimeout: () => void;
}): ChoiceCountdown {
  const totalMs = seconds != null && seconds > 0 ? seconds * 1000 : 0;
  const remainingMs = useStoryTimer({ delayMs: totalMs, active: active && totalMs > 0, paused, resetKey, onElapsed: onTimeout });

  const fraction = totalMs > 0 ? remainingMs / totalMs : 1;
  return { remainingMs, fraction };
}
