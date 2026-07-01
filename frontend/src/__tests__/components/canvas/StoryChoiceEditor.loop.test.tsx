// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StoryChoiceEditor } from '@/components/canvas/StoryChoiceEditor';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 一个故事组 + 两个组内视频成员。members selector 只有在组内有成员时才会 map 出对象,
// 因此复现死循环必须让 sourceNode 挂在有成员的组下。
function seedStoryGroup() {
  useCanvasStore.getState().setCanvasData(
    [
      { id: 'g1', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { storyGroup: true } },
      {
        id: 'v1',
        type: CANVAS_NODE_TYPES.video,
        parentId: 'g1',
        position: { x: 0, y: 0 },
        data: { videoUrl: 'a.mp4', aspectRatio: '16:9', displayName: '片段一' },
      },
      {
        id: 'v2',
        type: CANVAS_NODE_TYPES.video,
        parentId: 'g1',
        position: { x: 400, y: 0 },
        data: { videoUrl: 'b.mp4', aspectRatio: '16:9', displayName: '片段二' },
      },
    ] as never,
    [],
  );
}

describe('StoryChoiceEditor 渲染不触发无限重渲染', () => {
  beforeEach(seedStoryGroup);

  it('组内有成员时挂载编辑器不应抛 "Maximum update depth exceeded"', () => {
    // 修复前:members selector 在 useShallow 内 .map 出新对象,快照永不相等 → useSyncExternalStore
    // 判定快照一直在变 → React 抛 "Maximum update depth exceeded"。render 会同步抛出使本用例失败。
    expect(() =>
      render(
        <StoryChoiceEditor
          edgeId="e1"
          sourceNodeId="v1"
          choiceText="去片段二"
          variables={[]}
        />,
      ),
    ).not.toThrow();
  });
});
