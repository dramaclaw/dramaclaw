// SPDX-License-Identifier: Elastic-2.0
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { isImmersiveViewerActive } from '@/features/viewer-kit/useViewerImmersiveBody';
import { ImageViewerModal } from '@/features/canvas/ui/ImageViewerModal';

const images = ['/static/current.png', '/static/history.png'];
function Viewer({ onClose = () => { } }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  return <>
    <button onClick={() => setOpen(true)}>打开图片</button>
    <ImageViewerModal open={open} imageUrl={images[index]} imageList={images} currentIndex={index}
      onClose={() => { setOpen(false); onClose(); }} onSelect={setIndex}
      onNavigate={direction => setIndex(value => Math.max(0, Math.min(images.length - 1, value + (direction === 'next' ? 1 : -1))))} />
  </>;
}

it('browses history with thumbnails and arrow keys, and closes with Escape', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<Viewer onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: '打开图片' }));
  const dialog = await screen.findByRole('dialog', { name: '查看图片详情' });
  expect(isImmersiveViewerActive()).toBe(true);
  const image = within(dialog).getByAltText('图片');
  await user.click(within(dialog).getByRole('button', { name: '查看第 2 张图片' }));
  expect(image).toHaveAttribute('src', images[1]);
  expect(onClose).not.toHaveBeenCalled();
  await user.keyboard('{ArrowLeft}');
  expect(image).toHaveAttribute('src', images[0]);
  fireEvent.click(image);
  expect(onClose).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(isImmersiveViewerActive()).toBe(false);
});

it('anchors close to the image and does not expose zoom or reset controls', async () => {
  const user = userEvent.setup();
  render(<Viewer />);
  await user.click(screen.getByRole('button', { name: '打开图片' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByTitle('重置视图')).not.toBeInTheDocument();
  expect(within(dialog).queryByText('100%')).not.toBeInTheDocument();
  const close = within(dialog).getByRole('button', { name: '关闭' });
  expect(close.parentElement).toBe(within(dialog).getByAltText('图片').parentElement);
  await user.click(close);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(isImmersiveViewerActive()).toBe(false);
});
