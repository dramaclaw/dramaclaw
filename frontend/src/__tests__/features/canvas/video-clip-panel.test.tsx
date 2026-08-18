// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoClipPanel } from '@/features/canvas/nodes/VideoClipPanel';

const captureVideoFrames = vi.hoisted(() => vi.fn());

vi.mock('@/features/canvas/application/videoFrameStrip', () => ({
  captureVideoFrames,
}));

const TOTAL_MS = 10_000;
/** 轨道宽 200px、左边贴 0：clientX 直接就是「毫秒 / 50」。 */
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

function renderPanel(overrides: Partial<Parameters<typeof VideoClipPanel>[0]> = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const onExit = vi.fn();
  const view = render(
    <VideoClipPanel
      videoUrl="https://cdn.example.com/a.mp4"
      durationMs={TOTAL_MS}
      clipStartMs={1_000}
      clipEndMs={5_000}
      onChange={onChange}
      onExit={onExit}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { ...view, onChange, onExit, onSubmit };
}

function handles() {
  const start = screen.getByRole('slider', { name: '剪辑起点' });
  const end = screen.getByRole('slider', { name: '剪辑终点' });
  const selection = start.parentElement as HTMLElement;
  const track = selection.parentElement as HTMLElement;
  return { start, end, selection, track };
}

beforeEach(() => {
  captureVideoFrames.mockReset();
  captureVideoFrames.mockResolvedValue(['data:image/jpeg;base64,a']);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(TRACK_RECT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VideoClipPanel 拖拽', () => {
  it('拖动过程中不写节点，松手才提交一次', () => {
    const { onChange } = renderPanel();
    const { start } = handles();

    fireEvent.pointerDown(start, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 60, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 50, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 40, pointerId: 1 });

    // 关键：updateNodeData 每次调用都会压一份画布快照并清空 redo 栈，
    // 拖拽途中一次都不能调。
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(start, { clientX: 40, pointerId: 1 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ clipStartMs: 2_000 });
  });

  it('起点不会越过终点，最少留 200ms', () => {
    const { onChange } = renderPanel();
    const { start } = handles();

    fireEvent.pointerDown(start, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 180, pointerId: 1 });
    fireEvent.pointerUp(start, { clientX: 180, pointerId: 1 });

    expect(onChange).toHaveBeenCalledWith({ clipStartMs: 4_800 });
  });

  it('拖选区中段整体平移，时长不变', () => {
    const { onChange } = renderPanel();
    const { selection } = handles();

    fireEvent.pointerDown(selection, { clientX: 60, pointerId: 1 });
    fireEvent.pointerMove(selection, { clientX: 80, pointerId: 1 });
    fireEvent.pointerUp(selection, { clientX: 80, pointerId: 1 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ clipStartMs: 2_000, clipEndMs: 6_000 });
  });

  it('在轨道空白处按下会把近的那一端拉过来', () => {
    const { onChange } = renderPanel();
    const { track } = handles();

    // 8_000ms 离终点 5_000 更近，应该拉终点而不是起点。
    fireEvent.pointerDown(track, { clientX: 160, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 160, pointerId: 1 });

    expect(onChange).toHaveBeenCalledWith({ clipEndMs: 8_000 });
  });
});

describe('VideoClipPanel 键盘', () => {
  it('方向键按 100ms 步进，Shift 按 1s', () => {
    const { onChange } = renderPanel();
    const { start } = handles();

    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith({ clipStartMs: 1_100 });

    fireEvent.keyDown(start, { key: 'ArrowLeft', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ clipStartMs: 0 });
  });

  it('终点的 End 键跳到片尾', () => {
    const { onChange } = renderPanel();
    const { end } = handles();

    fireEvent.keyDown(end, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith({ clipEndMs: TOTAL_MS });
  });

  it('提交中不响应键盘', () => {
    const { onChange } = renderPanel({ isSubmitting: true });
    const { start } = handles();

    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('VideoClipPanel 轨道宽度', () => {
  it('轨道按时长给像素，长素材摊得开', () => {
    renderPanel({ durationMs: 44_000 });
    // 44s × 14px/s = 616px，而不是被节点宽度压成两百来像素。
    expect(handles().track.style.minWidth).toBe('616px');
  });

  it('太短的素材有下限，太长的有上限', () => {
    const short = renderPanel({ durationMs: 3_000 });
    expect(handles().track.style.minWidth).toBe('260px');
    short.unmount();

    renderPanel({ durationMs: 600_000 });
    expect(handles().track.style.minWidth).toBe('960px');
  });

  it('轨道越宽抽越多帧，格子不会被拉变形', () => {
    const short = renderPanel({ durationMs: 3_000 });
    expect(captureVideoFrames).toHaveBeenLastCalledWith(expect.any(String), 6);
    short.unmount();

    renderPanel({ durationMs: 600_000 });
    expect(captureVideoFrames).toHaveBeenLastCalledWith(expect.any(String), 10);
  });
});

describe('VideoClipPanel 缩略图', () => {
  it('抽到几帧就铺几格，不用黑格子凑数', async () => {
    captureVideoFrames.mockResolvedValue([
      'data:image/jpeg;base64,a',
      'data:image/jpeg;base64,b',
      'data:image/jpeg;base64,c',
    ]);
    const { container } = renderPanel();

    await waitFor(() => {
      expect(container.querySelectorAll('[style*="background-image"]')).toHaveLength(3);
    });
  });

  it('失败后可以重试', async () => {
    captureVideoFrames.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderPanel();

    const retry = await screen.findByRole('button', { name: '重新提取画面帧' });
    expect(captureVideoFrames).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() => {
      expect(captureVideoFrames).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByText('画面帧加载失败')).toBeNull();
    });
  });

  it('滚轮不穿透到画布（nowheel）', () => {
    const { container } = renderPanel();
    expect(container.firstElementChild?.className).toContain('nowheel');
  });
});
