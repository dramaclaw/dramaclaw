// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { NodeMediaReplaceButton } from '@/features/canvas/ui/NodeMediaReplaceButton';

/** 真实浏览器点一下 = pointerdown → pointerup → click，测试里必须原样重放。 */
function realClick(button: HTMLElement, opts: { moveBy?: number } = {}) {
  fireEvent.pointerDown(button, { button: 0, clientX: 100, clientY: 100 });
  if (opts.moveBy) {
    fireEvent.pointerMove(window, {
      clientX: 100 + opts.moveBy,
      clientY: 100,
    });
  }
  fireEvent.pointerUp(window, { clientX: 100, clientY: 100 });
  fireEvent.click(button);
}

describe('NodeMediaReplaceButton', () => {
  it('点击拉起文件选择器', () => {
    render(<NodeMediaReplaceButton title="替换" onPick={vi.fn()} onCommitDragStart={vi.fn()} />);
    const button = screen.getByRole('button', { name: '替换' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    realClick(button);

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('越过阈值的拖拽不再当点击', () => {
    const onCommitDragStart = vi.fn();
    render(
      <NodeMediaReplaceButton title="替换" onPick={vi.fn()} onCommitDragStart={onCommitDragStart} />,
    );
    const button = screen.getByRole('button', { name: '替换' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    realClick(button, { moveBy: 40 });

    expect(onCommitDragStart).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
