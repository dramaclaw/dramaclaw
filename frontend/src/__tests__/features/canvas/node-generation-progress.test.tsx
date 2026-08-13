// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 节点生成进度曲线的行为契约。
 *
 * 旧实现是 `Math.min(elapsed / duration, 0.96)`：走到预估时长就撞硬顶，而真实
 * 生成常比预估慢一截，于是几乎每次都停在 96%。换成指数饱和曲线后，停下来的
 * 位置推到约 3.8 倍预估时长。
 *
 * 这里连「99% 之后不再变化」一起锁住——它是当前实现有意接受的代价，不是漏网
 * 的 bug；将来若改成不定式等待动效，这条用例应当被显式改掉而不是悄悄失效。
 */
import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';

const DURATION_MS = 60_000;

function renderProgress() {
  const { container } = render(
    <NodeGenerationOverlay startedAt={0} durationMs={DURATION_MS} />,
  );
  const bar = container.querySelector('[role="progressbar"]');
  if (!bar) throw new Error('progressbar not rendered');
  return () => Number(bar.getAttribute('aria-valuenow'));
}

/** 推进到「预估时长的 n 倍」这一刻。 */
function advanceToMultiple(multiple: number) {
  act(() => {
    // 组件靠 120ms 的 interval 驱动重渲染，跑一拍即可；先退一拍再推进，
    // 落点才正好是 multiple × 预估时长。
    vi.setSystemTime(multiple * DURATION_MS - 120);
    vi.advanceTimersByTime(120);
  });
}

describe('NodeGenerationOverlay 进度曲线', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('预估时长内推进保守，不会提前贴到高位', () => {
    const percent = renderProgress();
    expect(percent()).toBe(0);

    advanceToMultiple(0.5);
    expect(percent()).toBe(50);

    // 走满预估时长时约 75%，留足余量给普遍存在的超时。
    advanceToMultiple(1);
    expect(percent()).toBe(74);
  });

  it('超出预估时长后仍在推进，不像旧的线性版本那样在 1 倍时长就撞顶', () => {
    const percent = renderProgress();

    advanceToMultiple(2);
    expect(percent()).toBe(93);

    advanceToMultiple(3);
    expect(percent()).toBe(98);
  });

  it('约 3.8 倍预估时长后定在 99%，之后不再变化', () => {
    const percent = renderProgress();

    advanceToMultiple(3.5);
    expect(percent()).toBe(98);

    advanceToMultiple(4);
    expect(percent()).toBe(99);

    // 再等一个数量级也还是 99——这是有意的上限，不是曲线算错。
    advanceToMultiple(40);
    expect(percent()).toBe(99);
  });

  it('永远不会显示 100%——完成由外部卸载覆盖层来体现', () => {
    const percent = renderProgress();
    for (const multiple of [1, 5, 20, 100, 1000]) {
      advanceToMultiple(multiple);
      expect(percent()).toBeLessThan(100);
    }
  });

  it('进度单调不降', () => {
    const percent = renderProgress();
    let previous = percent();
    for (let multiple = 0.2; multiple <= 6; multiple += 0.2) {
      advanceToMultiple(multiple);
      const current = percent();
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
