// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { StoryOverviewPanel } from '@/components/canvas/StoryOverviewPanel';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('shows choice paths as nested branches with their scripts', () => {
  useCanvasStore.setState({
    nodes: [
      { id: 'story', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 },
        data: { storyGroup: true, displayName: '故事' } },
      { id: 'start', parentId: 'story', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
        data: { storyRole: 'start', displayName: '开场', narration: '主角来到路口。' } },
      { id: 'left', parentId: 'story', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
        data: { displayName: '左路', narration: '走进树林。' } },
      { id: 'right', parentId: 'story', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
        data: { displayName: '右路', narration: '来到河边。' } },
    ] as CanvasNode[],
    edges: [
      { id: 'left-choice', source: 'start', target: 'left', type: STORY_CHOICE_EDGE_TYPE,
        data: { choiceText: '往左', order: 0 } },
      { id: 'right-choice', source: 'start', target: 'right', type: STORY_CHOICE_EDGE_TYPE,
        data: { choiceText: '往右', order: 1 } },
    ] as CanvasEdge[],
  });

  const view = render(<StoryOverviewPanel groupId="story" onClose={vi.fn()} />);
  const root = view.container.querySelector('[data-story-branch-node="start"]');
  expect(root).toHaveAttribute('data-root', 'true');
  expect(root).toHaveTextContent('主角来到路口。');
  const children = root?.querySelectorAll(':scope > ul > [data-story-branch-node]');
  expect(Array.from(children ?? [], (child) => child.getAttribute('data-story-branch-node'))).toEqual(['left', 'right']);
  expect(children?.[0]).toHaveTextContent('往左');
  expect(children?.[0]).toHaveTextContent('走进树林。');
  expect(children?.[1]).toHaveTextContent('往右');
  expect(children?.[1]).toHaveTextContent('来到河边。');
});
