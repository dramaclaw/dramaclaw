// SPDX-License-Identifier: Elastic-2.0
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VideoViewerModal } from '@/features/canvas/ui/VideoViewerModal';

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function(this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    this.dispatchEvent(new Event('play')); return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
    this.dispatchEvent(new Event('pause'));
  });
});
afterEach(() => vi.restoreAllMocks());

const videos = ['/static/current.mp4', '/static/history.mp4'];
function Viewer() {
  const [open, setOpen] = useState(true), [index, setIndex] = useState(0);
  return <VideoViewerModal open={open} videoUrl={videos[index]} videoList={videos} currentIndex={index}
    onClose={() => setOpen(false)} onSelect={setIndex} onNavigate={direction => setIndex(value => Math.max(0, Math.min(1, value + (direction === 'next' ? 1 : -1))))} />;
}

it('reuses the media frame, switches history, and pauses the old video on switch and close', async () => {
  const user = userEvent.setup();
  render(<Viewer />);
  const dialog = await screen.findByRole('dialog');
  const current = dialog.querySelector('video')!;
  expect(current.parentElement).toBe(screen.getByRole('button', { name: '关闭' }).parentElement);
  await user.click(screen.getByRole('button', { name: '查看第 2 个视频' }));
  const next = dialog.querySelector('video')!;
  expect(next).not.toBe(current);
  expect(next).toHaveAttribute('src', videos[1]);
  expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.instances).toContain(current);
  await user.click(screen.getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.instances).toContain(next);
});

it('lets the seek slider own its arrow keys and keeps playback functional', async () => {
  const user = userEvent.setup(), navigate = vi.fn();
  render(<VideoViewerModal open videoUrl={videos[0]} onClose={() => { }} onNavigate={navigate} />);
  await screen.findByRole('dialog');
  fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
  expect(navigate).not.toHaveBeenCalled();
  await user.click(screen.getByTitle('播放'));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  expect(await screen.findByTitle('暂停')).toBeInTheDocument();
});
