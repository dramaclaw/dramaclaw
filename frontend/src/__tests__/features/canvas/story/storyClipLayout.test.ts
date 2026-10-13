// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveStoryGroupAtCanvasPoint,
  resolveStoryGroupForChoiceConnection,
  resolveStoryGroupForNewVideo,
  storySegmentPositionInGroup,
} from '@/features/canvas/story/storyClipLayout';

function storyGroup(id: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.group,
    position: { x: 0, y: 0 },
    data: { label: '互动影游', storyGroup: true },
  } as CanvasNode;
}

function storyClip(id: string, parentId: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    parentId,
    position: { x: 0, y: 0 },
    data: { videoUrl: null },
  } as CanvasNode;
}

describe('resolveStoryGroupForNewVideo', () => {
  it('选中故事组时把新视频加入该组', () => {
    const nodes = [storyGroup('story-a'), storyClip('clip-a', 'story-a')];
    expect(resolveStoryGroupForNewVideo(nodes, 'story-a')).toBe('story-a');
  });

  it('选中组内片段时沿用它的故事组', () => {
    const nodes = [storyGroup('story-a'), storyClip('clip-a', 'story-a')];
    expect(resolveStoryGroupForNewVideo(nodes, 'clip-a')).toBe('story-a');
  });

  it('画布中只有一个故事组时可以无选中兜底', () => {
    const nodes = [storyGroup('story-a'), storyClip('clip-a', 'story-a')];
    expect(resolveStoryGroupForNewVideo(nodes, null)).toBe('story-a');
  });

  it('多故事组且无上下文时不猜测归属', () => {
    const nodes = [storyGroup('story-a'), storyGroup('story-b')];
    expect(resolveStoryGroupForNewVideo(nodes, null)).toBeNull();
  });

  it('选中普通视频时不误入多故事组', () => {
    const nodes = [
      storyGroup('story-a'),
      storyGroup('story-b'),
      {
        id: 'plain-video',
        type: CANVAS_NODE_TYPES.video,
        position: { x: 0, y: 0 },
        data: { videoUrl: null },
      } as CanvasNode,
    ];
    expect(resolveStoryGroupForNewVideo(nodes, 'plain-video')).toBeNull();
  });

  it('选中普通节点时不会被单故事组兜底抢走', () => {
    const nodes = [
      storyGroup('story-a'),
      {
        id: 'plain-video',
        type: CANVAS_NODE_TYPES.video,
        position: { x: 0, y: 0 },
        data: { videoUrl: null },
      } as CanvasNode,
    ];
    expect(resolveStoryGroupForNewVideo(nodes, 'plain-video')).toBeNull();
  });
});

describe('画布落点新增故事片段', () => {
  it('视频落点在故事组内时命中该组', () => {
    const group = {
      ...storyGroup('story-a'),
      position: { x: 100, y: 80 },
      width: 1600,
      height: 900,
    } as CanvasNode;
    expect(resolveStoryGroupAtCanvasPoint([group], { x: 900, y: 400 })).toBe('story-a');
    expect(resolveStoryGroupAtCanvasPoint([group], { x: 50, y: 40 })).toBeNull();
  });

  it('把落点中心换算为故事组内相对坐标', () => {
    const group = {
      ...storyGroup('story-a'),
      position: { x: 100, y: 80 },
      width: 1600,
      height: 900,
    } as CanvasNode;
    expect(storySegmentPositionInGroup([group], 'story-a', { x: 900, y: 400 })).toEqual({
      x: 460,
      y: 130,
    });
  });
});

describe('剧情节点连线', () => {
  it('只有同一故事组里的两个视频节点才识别为剧情选项连线', () => {
    const nodes = [
      storyGroup('story-a'),
      storyGroup('story-b'),
      storyClip('clip-a', 'story-a'),
      storyClip('clip-b', 'story-a'),
      storyClip('clip-c', 'story-b'),
      {
        id: 'plain-video',
        type: CANVAS_NODE_TYPES.video,
        position: { x: 0, y: 0 },
        data: { videoUrl: null },
      } as CanvasNode,
    ];

    expect(resolveStoryGroupForChoiceConnection(nodes, 'clip-a', 'clip-b')).toBe('story-a');
    expect(resolveStoryGroupForChoiceConnection(nodes, 'clip-a', 'clip-c')).toBeNull();
    expect(resolveStoryGroupForChoiceConnection(nodes, 'clip-a', 'plain-video')).toBeNull();
  });
});
