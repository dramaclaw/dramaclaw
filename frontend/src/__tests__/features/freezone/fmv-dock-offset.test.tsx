// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 虾导抽屉是通屏高的 fixed 浮层：右侧的 fmv 浮层（大纲方案卡、剧本总览）
// 必须走 dockOffset 让位协议往左收，否则抽屉一开就把内容整个盖住。
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { PendingOutlineCard } from '@/features/freezone/PendingOutlineCard';
import { StoryOverviewPanel } from '@/components/canvas/StoryOverviewPanel';
import { FREEZONE_DOCK_OFFSET_ANIMATED_STYLE } from '@/features/freezone/dockOffset';
import type { PendingStoryOutline } from '@/features/canvas/story/pendingStoryOutline';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/freezone/canvasSyncRuntime', () => ({
  refreshRemoteFreezoneCanvas: vi.fn(),
}));

afterEach(cleanup);

const DOCK_MAX_WIDTH = 'max-w-[calc(100%_-_2rem_-_var(--freezone-dock-width,0px))]';

function outline(): PendingStoryOutline {
  return {
    outline_id: 'outline-round-1',
    kind: 'story',
    title: '雨夜出租车',
    premise: 'p',
    plot_summary: 's',
    interaction_summary: '',
    endings_summary: '',
    duration_budget_sec: null,
    open_questions: [],
    status: 'pending',
    story_id: null,
    updated_at: '2026-09-21T00:00:00Z',
  };
}

it('pending outline card yields to the chat dock instead of hiding under it', () => {
  const view = render(
    <PendingOutlineCard
      projectId="p1"
      canvasId="c1"
      outline={outline()}
      canvasRevision={3}
    />,
  );
  const card = view.container.firstElementChild!;
  expect(card).toHaveStyle({ ...FREEZONE_DOCK_OFFSET_ANIMATED_STYLE });
  expect(card.className).toContain(DOCK_MAX_WIDTH);
});

it('dismissing the card collapses it into a reopen pill instead of losing the outline', () => {
  const view = render(
    <PendingOutlineCard
      projectId="p1"
      canvasId="c1"
      outline={outline()}
      canvasRevision={3}
    />,
  );
  fireEvent.click(view.getByRole('button', { name: 'freezone.outline.dismiss' }));
  // 收起后只剩胶囊入口，确认按钮随之隐藏。
  expect(view.queryByRole('button', { name: 'freezone.outline.confirm' })).toBeNull();
  const pill = view.getByRole('button', { name: 'freezone.outline.reopen' });
  expect(pill).toHaveTextContent('雨夜出租车');
  // 胶囊同样接让位协议（样式在包裹容器上）。
  expect(pill.parentElement).toHaveStyle({ ...FREEZONE_DOCK_OFFSET_ANIMATED_STYLE });
  // 点开重新展开，内容还在。
  fireEvent.click(pill);
  expect(view.getByRole('button', { name: 'freezone.outline.confirm' })).toBeInTheDocument();
  expect(view.queryByRole('button', { name: 'freezone.outline.reopen' })).toBeNull();
});

it('story overview panel yields to the chat dock like the lint/tree panels', () => {
  const group = {
    id: 'g1',
    type: CANVAS_NODE_TYPES.group,
    position: { x: 0, y: 0 },
    data: { storyGroup: true, storySynopsis: 'synopsis' },
  } as unknown as CanvasNode;
  useCanvasStore.setState({ nodes: [group], edges: [] });
  const view = render(<StoryOverviewPanel groupId="g1" onClose={vi.fn()} />);
  const panel = view.container.firstElementChild!;
  expect(panel).toHaveStyle({ ...FREEZONE_DOCK_OFFSET_ANIMATED_STYLE });
  expect(panel.className).toContain(DOCK_MAX_WIDTH);
});

it('story overview opens below the story toolbar', () => {
  const toolbar = document.createElement('div');
  toolbar.setAttribute('data-story-toolbar-region', '');
  vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue({ bottom: 92 } as DOMRect);
  document.body.append(toolbar);
  useCanvasStore.setState({ nodes: [{
    id: 'g1', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { storyGroup: true },
  } as CanvasNode], edges: [] });
  try {
    const view = render(<StoryOverviewPanel groupId="g1" onClose={vi.fn()} />);
    expect(view.getByRole('dialog')).toHaveStyle({ top: '100px' });
    expect(view.getByRole('dialog')).toHaveStyle({ maxHeight: 'min(78vh, calc(100dvh - 100px - 16px))' });
  } finally {
    toolbar.remove();
  }
});

it('story overview width can be dragged and adjusted from the keyboard', () => {
  useCanvasStore.setState({ nodes: [{
    id: 'g1', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { storyGroup: true },
  } as CanvasNode], edges: [] });
  const view = render(<StoryOverviewPanel groupId="g1" onClose={vi.fn()} />);
  const panel = view.getByRole('dialog');
  const handle = view.getByRole('separator', { name: 'canvas.story.overview.resize' });

  expect(panel).toHaveStyle({ width: '420px' });
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 600 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480 });
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 480 });
  expect(panel).toHaveStyle({ width: '540px' });

  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  expect(panel).toHaveStyle({ width: '564px' });

  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ right: 600, width: 564 } as DOMRect);
  fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 600 });
  fireEvent.pointerMove(handle, { pointerId: 2, clientX: 0 });
  fireEvent.pointerUp(handle, { pointerId: 2, clientX: 0 });
  expect(panel).toHaveStyle({ width: '584px' });
});
