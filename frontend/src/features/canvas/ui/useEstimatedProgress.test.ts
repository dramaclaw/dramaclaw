// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEstimatedProgress } from './useEstimatedProgress';

describe('useEstimatedProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('startedAt 为 null 时退化为从挂载时刻计时，渲染瞬间为 0%', () => {
    const { result } = renderHook(() => useEstimatedProgress(null, 10_000));
    expect(result.current).toBe(0);
  });

  it('按 elapsed/duration 指数饱和推进，120ms 轮询刷新', () => {
    const startedAt = Date.now();
    const { result } = renderHook(() => useEstimatedProgress(startedAt, 10_000));
    expect(result.current).toBe(0);

    // 10s 预估时长，推进 2s。2000ms 是 120 的非整数倍，最后一拍落在
    // 1920ms（16 拍），指数饱和估算为 23%——用这个同时验证轮询节奏与算法。
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(23);
  });

  it('封顶 99%：即使远超预估时长也不会到 100%（真正完成由调用方 isGenerating 触发）', () => {
    const startedAt = Date.now();
    const { result } = renderHook(() => useEstimatedProgress(startedAt, 1_000));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(99);
  });

  it('durationMs 钳到最短 1000ms（避免传入极小值时进度瞬间冲到封顶）', () => {
    const startedAt = Date.now();
    const { result } = renderHook(() => useEstimatedProgress(startedAt, 10));
    act(() => {
      vi.advanceTimersByTime(120);
    });
    // duration 钳到 1000ms：120ms 按指数饱和估算为 15%，而不是被 durationMs=10 撑到瞬间封顶。
    expect(result.current).toBe(15);
  });

  it('卸载后清掉轮询定时器（不残留 setInterval）', () => {
    const startedAt = Date.now();
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const { unmount } = renderHook(() => useEstimatedProgress(startedAt, 10_000));
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
