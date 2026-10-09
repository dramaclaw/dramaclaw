// SPDX-License-Identifier: Elastic-2.0
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ReferenceMentionButton } from '@/features/canvas/nodes/shared/ReferenceMentionButton';
import { ReferenceDetachButton } from '@/features/canvas/nodes/shared/ReferenceDetachButton';
import { NODE_REFERENCE_MEDIA_CHIP_CLASS, NODE_REFERENCE_MEDIA_DETACH_CLASS } from '@/features/canvas/ui/nodeControlStyles';

it('inserts once from the thumbnail and does not insert when detaching', async () => {
  const user = userEvent.setup();
  const insert = vi.fn(), detach = vi.fn(), focus = vi.fn();
  render(<div className={NODE_REFERENCE_MEDIA_CHIP_CLASS} onClick={focus}>
    <img src="/static/ref.png" alt="参考图片" />
    <ReferenceMentionButton mentionName="图片1" onInsert={insert} />
    <ReferenceDetachButton as="button" nodeId="source" onDetach={detach} className={NODE_REFERENCE_MEDIA_DETACH_CLASS} />
  </div>);
  await user.click(screen.getByRole('button', { name: '在提示词中引用「图片1」' }));
  expect(insert).toHaveBeenCalledOnce();
  expect(focus).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '取消引用此素材' }));
  expect(detach).toHaveBeenCalledWith('source');
  expect(insert).toHaveBeenCalledOnce();
  expect(focus).not.toHaveBeenCalled();
});

it('supports keyboard insertion and detachment without firing the parent action', async () => {
  const user = userEvent.setup();
  const insert = vi.fn(), detach = vi.fn(), parent = vi.fn();
  render(<div onClick={parent}>
    <ReferenceMentionButton mentionName="图片2" onInsert={insert} />
    <ReferenceDetachButton as="button" nodeId="source" onDetach={detach} />
  </div>);
  screen.getByRole('button', { name: '在提示词中引用「图片2」' }).focus();
  await user.keyboard('{Enter}');
  expect(insert).toHaveBeenCalledOnce();
  screen.getByRole('button', { name: '取消引用此素材' }).focus();
  await user.keyboard(' ');
  expect(detach).toHaveBeenCalledWith('source');
  expect(insert).toHaveBeenCalledOnce();
  expect(parent).not.toHaveBeenCalled();
});


it('preserves source jumping on double-click without inserting duplicate mentions', async () => {
  const user = userEvent.setup();
  const insert = vi.fn(), jump = vi.fn();
  render(<ReferenceMentionButton mentionName="图片1" onInsert={insert} onJump={jump} />);
  await user.dblClick(screen.getByRole('button', { name: '在提示词中引用「图片1」' }));
  expect(insert).toHaveBeenCalledOnce();
  expect(jump).toHaveBeenCalledOnce();
});
