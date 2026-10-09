// SPDX-License-Identifier: Elastic-2.0
import { beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PromptMentionEditor, type MentionCandidate } from '@/features/canvas/nodes/PromptMentionEditor';
import { mediaHoverPreviewPlacement } from '@/features/canvas/ui/MediaHoverPreview';

beforeAll(() => { if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn(); });
const candidates: MentionCandidate[] = [
  { key: 'a', name: '图片1', imageUrl: '/static/a.png', index: 1 },
  { key: 'b', name: '图片2', imageUrl: '/static/b.png', index: 2 },
];

it('previews the hovered @ candidate and removes the preview on Escape', () => {
  const { container } = render(<PromptMentionEditor value="" onChange={() => { }} candidates={candidates} />);
  const editor = container.querySelector('[contenteditable]')!;
  editor.textContent = '@';
  const range = document.createRange(); range.setStart(editor.firstChild!, 1); range.collapse(true);
  Object.defineProperty(range, 'getBoundingClientRect', { value: () => new DOMRect(180, 180, 0, 14) });
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  fireEvent.input(editor);
  const row = screen.getByText('@2').closest('button')!;
  fireEvent.mouseEnter(row);
  expect(screen.getByRole('img', { name: '引用素材预览' }).querySelector('img')).toHaveAttribute('src', '/static/b.png');
  fireEvent.keyDown(editor, { key: 'Escape' });
  expect(screen.queryByRole('img', { name: '引用素材预览' })).not.toBeInTheDocument();
  expect(editor.textContent).toBe('@');
});

it('previews replacement candidates without changing the referenced asset until selection', () => {
  const change = vi.fn();
  const { container } = render(<PromptMentionEditor value="@图片1 " onChange={change} candidates={candidates} />);
  fireEvent.doubleClick(container.querySelector('.mention-chip')!);
  const row = screen.getByText('@2').closest('button')!;
  fireEvent.mouseEnter(row);
  expect(screen.getByRole('img', { name: '引用素材预览' }).querySelector('img')).toHaveAttribute('src', '/static/b.png');
  expect(change).not.toHaveBeenCalled();
  fireEvent.mouseDown(row);
  expect(change).toHaveBeenCalledWith('@图片2 ');
  expect(screen.queryByRole('img', { name: '引用素材预览' })).not.toBeInTheDocument();
});

it('positions previews beside candidates and flips within the viewport near its right edge', () => {
  const right = mediaHoverPreviewPlacement({ rect: { left: 200, right: 440, top: 160, bottom: 200 }, placement: 'side' }, 1024, 768);
  expect(right.left).toBeGreaterThan(440);
  const edge = mediaHoverPreviewPlacement({ rect: { left: 780, right: 1020, top: 700, bottom: 740 }, placement: 'side' }, 1024, 768);
  expect(edge.left + edge.width).toBeLessThan(780);
  expect(edge.top + edge.height).toBeLessThanOrEqual(760);
});
