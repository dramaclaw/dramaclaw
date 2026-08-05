// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOD_SHELL_EXEMPT_TYPES,
  LOW_DETAIL_ZOOM_THRESHOLD,
  isCanvasGestureActive,
  isCanvasMeasurementDeferred,
  isLowDetailZoom,
  isNodeMediaActive,
  onCanvasMeasurementResume,
  requestShellUpgrade,
  setCanvasGestureActive,
  setCanvasLowDetail,
  setNodeMediaActive,
} from '@/features/canvas/application/canvasLod';

describe('isLowDetailZoom', () => {
  it('阈值以下才算低缩放档，边界值本身不算', () => {
    expect(isLowDetailZoom(LOW_DETAIL_ZOOM_THRESHOLD - 0.01)).toBe(true);
    expect(isLowDetailZoom(LOW_DETAIL_ZOOM_THRESHOLD)).toBe(false);
    expect(isLowDetailZoom(LOW_DETAIL_ZOOM_THRESHOLD + 0.01)).toBe(false);
  });

  it('常用工作缩放区间(0.5~1)不受影响', () => {
    expect(isLowDetailZoom(0.5)).toBe(false);
    expect(isLowDetailZoom(1)).toBe(false);
  });

  it('非有限值一律按「不降级」处理，避免初始化期误判', () => {
    expect(isLowDetailZoom(Number.NaN)).toBe(false);
    expect(isLowDetailZoom(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isLowDetailZoom(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe('画布测量延迟信号', () => {
  beforeEach(() => {
    // 模块级状态跨用例存活，每个用例前复位。
    setCanvasGestureActive(false);
    setCanvasLowDetail(false);
  });

  it('默认可以测量', () => {
    expect(isCanvasMeasurementDeferred()).toBe(false);
  });

  it('手势中或低缩放档都要跳过测量', () => {
    setCanvasGestureActive(true);
    expect(isCanvasMeasurementDeferred()).toBe(true);

    setCanvasGestureActive(false);
    setCanvasLowDetail(true);
    expect(isCanvasMeasurementDeferred()).toBe(true);
  });

  it('画布静下来时通知订阅方补测', () => {
    const listener = vi.fn();
    onCanvasMeasurementResume(listener);

    setCanvasGestureActive(true);
    expect(listener).not.toHaveBeenCalled();

    setCanvasGestureActive(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('另一个条件仍在延迟时不通知——否则会在低缩放档下白量一遍', () => {
    const listener = vi.fn();
    onCanvasMeasurementResume(listener);

    setCanvasGestureActive(true);
    setCanvasLowDetail(true);

    // 手势结束，但仍处于低缩放档：还不能测量。
    setCanvasGestureActive(false);
    expect(listener).not.toHaveBeenCalled();

    // 缩放拉回来，此时才真正静止。
    setCanvasLowDetail(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('重复设置同一状态不会重复通知', () => {
    const listener = vi.fn();
    onCanvasMeasurementResume(listener);

    setCanvasGestureActive(true);
    setCanvasGestureActive(true);
    setCanvasGestureActive(false);
    setCanvasGestureActive(false);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('退订后不再收到通知', () => {
    const listener = vi.fn();
    const unsubscribe = onCanvasMeasurementResume(listener);

    setCanvasGestureActive(true);
    unsubscribe();
    setCanvasGestureActive(false);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('节点媒体活跃信号', () => {
  it('标记/清除/查询是一致的', () => {
    expect(isNodeMediaActive('n1')).toBe(false);
    setNodeMediaActive('n1', true);
    expect(isNodeMediaActive('n1')).toBe(true);
    expect(isNodeMediaActive('n2')).toBe(false);
    setNodeMediaActive('n1', false);
    expect(isNodeMediaActive('n1')).toBe(false);
  });

  it('重复清除是幂等的（卸载清理与 onPause 会先后触发）', () => {
    setNodeMediaActive('n1', true);
    setNodeMediaActive('n1', false);
    setNodeMediaActive('n1', false);
    expect(isNodeMediaActive('n1')).toBe(false);
  });
});

describe('shell 升级队列', () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback): number => rafCallbacks.push(cb)
    );
    setCanvasGestureActive(false);
    setCanvasLowDetail(false);
  });

  /** 跑一「帧」：执行当前已排期的 rAF 回调（泵可能重新排期到下一帧）。 */
  const tick = () => {
    const callbacks = rafCallbacks.splice(0);
    for (const cb of callbacks) cb(0);
  };

  /** 用例收尾：把队列彻底放干，避免模块级状态泄漏到下一个用例。 */
  const drain = () => {
    setCanvasGestureActive(false);
    for (let i = 0; i < 50 && rafCallbacks.length > 0; i++) tick();
  };

  afterEach(() => {
    drain();
    vi.unstubAllGlobals();
  });

  it('每帧只放行 3 个，其余顺延后续帧', () => {
    const granted: number[] = [];
    for (let i = 0; i < 7; i++) requestShellUpgrade(() => granted.push(i));
    tick();
    expect(granted).toEqual([0, 1, 2]);
    tick();
    expect(granted).toEqual([0, 1, 2, 3, 4, 5]);
    tick();
    expect(granted).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('手势进行中不放行，手势结束后继续', () => {
    const granted = vi.fn();
    requestShellUpgrade(granted);
    requestShellUpgrade(granted);

    setCanvasGestureActive(true);
    expect(isCanvasGestureActive()).toBe(true);
    tick();
    expect(granted).not.toHaveBeenCalled();
    // 泵保持活着（重新排到下一帧），而不是死掉
    expect(rafCallbacks.length).toBeGreaterThan(0);

    setCanvasGestureActive(false);
    tick();
    expect(granted).toHaveBeenCalledTimes(2);
  });

  it('取消后不再放行（节点排队期间被卸载）', () => {
    const a = vi.fn();
    const b = vi.fn();
    const cancelA = requestShellUpgrade(a);
    requestShellUpgrade(b);
    cancelA();
    tick();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('shell 豁免清单', () => {
  it('组件内恢复逻辑/blur 落盘/动态 handle 的三类节点不做 shell', () => {
    // 这三类的豁免理由见 canvasLod.ts 注释；清单变更应当是有意的设计决定。
    expect([...LOD_SHELL_EXEMPT_TYPES].sort()).toEqual([
      'beatContextNode',
      'groupNode',
      'skillNode',
    ]);
  });
});
