import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChoiceCountdown } from '@/components/canvas/useChoiceCountdown';

describe('useChoiceCountdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('激活后倒数到 0 触发一次 onTimeout', () => {
    const onTimeout = vi.fn();
    const { result } = renderHook(() =>
      useChoiceCountdown({ seconds: 2, active: true, onTimeout }),
    );
    expect(result.current.fraction).toBe(1);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.fraction).toBeLessThan(1);
    expect(result.current.fraction).toBeGreaterThan(0);
    expect(onTimeout).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.remainingMs).toBe(0);
    expect(result.current.fraction).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    // 继续推进不再重复触发
    act(() => vi.advanceTimersByTime(2000));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('未激活时不计时、不触发', () => {
    const onTimeout = vi.fn();
    const { result } = renderHook(() =>
      useChoiceCountdown({ seconds: 2, active: false, onTimeout }),
    );
    act(() => vi.advanceTimersByTime(5000));
    expect(onTimeout).not.toHaveBeenCalled();
    expect(result.current.fraction).toBe(1);
  });

  it('seconds 为 null(不限时)时 fraction=1 且永不超时', () => {
    const onTimeout = vi.fn();
    const { result } = renderHook(() =>
      useChoiceCountdown({ seconds: null, active: true, onTimeout }),
    );
    act(() => vi.advanceTimersByTime(10000));
    expect(onTimeout).not.toHaveBeenCalled();
    expect(result.current.fraction).toBe(1);
  });

  it('active 由真转假时停止计时(不触发超时)', () => {
    const onTimeout = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useChoiceCountdown({ seconds: 2, active, onTimeout }),
      { initialProps: { active: true } },
    );
    act(() => vi.advanceTimersByTime(1000));
    rerender({ active: false });
    act(() => vi.advanceTimersByTime(5000));
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
