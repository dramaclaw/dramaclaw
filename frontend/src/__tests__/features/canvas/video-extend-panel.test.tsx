// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoExtendPanel } from '@/features/canvas/nodes/VideoExtendPanel';

const captureVideoFrames = vi.hoisted(() => vi.fn());

vi.mock('@/features/canvas/application/videoFrameStrip', () => ({
  captureVideoFrames,
}));

const TOTAL_MS = 60_000;
/** 轨道宽 200px、左边贴 0：clientX 直接就是「毫秒 / 300」。 */
const TRACK_RECT = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 200,
  bottom: 56,
  width: 200,
  height: 56,
  toJSON: () => ({}),
} as DOMRect;

function renderPanel(overrides: Partial<Parameters<typeof VideoExtendPanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const onExit = vi.fn();
  const view = render(
    <VideoExtendPanel
      videoUrl="https://cdn.example.com/a.mp4"
      durationMs={TOTAL_MS}
      onConfirm={onConfirm}
      onExit={onExit}
      {...overrides}
    />,
  );
  return { ...view, onConfirm, onExit };
}

function handles() {
  return {
    start: screen.getByRole('slider', { name: '续写片段起点' }),
    end: screen.getByRole('slider', { name: '续写片段终点' }),
    confirm: screen.getByRole('button', { name: /确认续写/ }),
  };
}

function drag(el: HTMLElement, toX: number) {
  fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: toX, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: toX, pointerId: 1 });
}

beforeEach(() => {
  captureVideoFrames.mockReset();
  captureVideoFrames.mockResolvedValue(['data:image/jpeg;base64,a']);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(TRACK_RECT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VideoExtendPanel 默认选区', () => {
  it('长素材默认贴着片尾取 30s', () => {
    renderPanel();
    expect(screen.getByText('30.00 秒')).toBeTruthy();
    expect(handles().start.getAttribute('aria-valuenow')).toBe('30000');
    expect(handles().end.getAttribute('aria-valuenow')).toBe('60000');
  });

  it('不足 30s 的素材整条都算前情', () => {
    renderPanel({ durationMs: 15_070 });
    expect(screen.getByText('15.07 秒')).toBeTruthy();
    expect(handles().confirm.hasAttribute('disabled')).toBe(false);
  });

  it('只截一段：轨道上永远只有一对把手', () => {
    renderPanel();
    expect(screen.getAllByRole('slider')).toHaveLength(2);
  });
});

describe('VideoExtendPanel 4-30s 边界', () => {
  it('缩到 4s 以下会被顶住并弹提示', () => {
    renderPanel();
    // 57_000ms 会让选区只剩 3s，被 4s 下限顶回 56_000。
    drag(handles().start, 190);

    expect(handles().start.getAttribute('aria-valuenow')).toBe('56000');
    expect(screen.getByText('所选视频最短不小于 4 秒')).toBeTruthy();
  });

  it('撑过 30s 会被顶住并弹提示', () => {
    renderPanel();
    // 起点往片头拖：选区已经是满 30s，再往左只会撞上限。
    drag(handles().start, 20);

    expect(handles().start.getAttribute('aria-valuenow')).toBe('30000');
    expect(screen.getByText('所选视频最长不大于 30 秒')).toBeTruthy();
  });

  it('提示过一会儿自己收掉，不挡下一次拖拽', () => {
    vi.useFakeTimers();
    try {
      renderPanel();
      drag(handles().start, 190);
      expect(screen.getByText('所选视频最短不小于 4 秒')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2_500);
      });
      expect(screen.queryByText('所选视频最短不小于 4 秒')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('没顶到边就不弹提示', () => {
    renderPanel();
    drag(handles().start, 140); // 42_000ms，选区 18s，两条边界都够不着

    expect(handles().start.getAttribute('aria-valuenow')).toBe('42000');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('素材本身不足 4s 时不给确认', () => {
    renderPanel({ durationMs: 3_000 });
    const { confirm } = handles();
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(confirm.getAttribute('title')).toBe('视频不足 4 秒，无法续写');
  });
});

describe('VideoExtendPanel 键盘', () => {
  it('方向键按 100ms 步进，Shift 按 1s', () => {
    renderPanel();
    const { start } = handles();

    // 默认选区正好满 30s，起点已经贴在上限上，只能往右（缩短）走。
    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(start.getAttribute('aria-valuenow')).toBe('30100');

    fireEvent.keyDown(start, { key: 'ArrowRight', shiftKey: true });
    expect(start.getAttribute('aria-valuenow')).toBe('31100');

    fireEvent.keyDown(start, { key: 'ArrowLeft' });
    expect(start.getAttribute('aria-valuenow')).toBe('31000');
  });

  it('选区已经满 30s 时，起点再往左也纹丝不动', () => {
    renderPanel();
    const { start } = handles();

    fireEvent.keyDown(start, { key: 'ArrowLeft' });
    expect(start.getAttribute('aria-valuenow')).toBe('30000');
    expect(screen.getByText('所选视频最长不大于 30 秒')).toBeTruthy();
  });

  it('键盘顶到边界也照弹提示', () => {
    renderPanel();
    fireEvent.keyDown(handles().start, { key: 'Home' });

    expect(handles().start.getAttribute('aria-valuenow')).toBe('30000');
    expect(screen.getByText('所选视频最长不大于 30 秒')).toBeTruthy();
  });
});

describe('VideoExtendPanel 出口', () => {
  it('确认把当前区间交出去', () => {
    const { onConfirm } = renderPanel();
    drag(handles().start, 140);
    fireEvent.click(handles().confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ startMs: 42_000, endMs: 60_000 });
  });

  it('X 退出截取', () => {
    const { onExit } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '退出续写截取' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('提交中不再响应键盘，也点不了确认', () => {
    renderPanel({ isSubmitting: true });
    const { start, confirm } = handles();

    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(start.getAttribute('aria-valuenow')).toBe('30000');
    expect(confirm.hasAttribute('disabled')).toBe(true);
  });

  it('滚轮不穿透到画布（nowheel）', () => {
    const { container } = renderPanel();
    expect(container.querySelector('.nowheel')).toBeTruthy();
  });
});
