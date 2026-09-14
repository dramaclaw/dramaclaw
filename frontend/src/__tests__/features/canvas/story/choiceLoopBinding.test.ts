import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  bindChoiceLoopPatch,
  choiceLoopVideoCandidates,
  clearChoiceLoopMediaPatch,
} from '@/features/canvas/story/choiceLoopBinding';

const node = (id: string, data: Record<string, unknown>, parentId?: string): CanvasNode => ({
  id,
  type: id.startsWith('group') ? CANVAS_NODE_TYPES.group : CANVAS_NODE_TYPES.video,
  position: { x: 0, y: 0 },
  ...(parentId ? { parentId } : {}),
  data,
} as CanvasNode);

describe('选择循环绑定', () => {
  it('只列出故事组外已有视频的节点', () => {
    const candidates = choiceLoopVideoCandidates([
      node('group', { storyGroup: true }),
      node('story-clip', { videoUrl: '/main.mp4' }, 'group'),
      node('loop', { displayName: '窗边循环', videoUrl: '/loop.mp4', durationMs: 3200 }),
      node('empty', { displayName: '未生成', videoUrl: null }),
    ], 'story-clip');
    expect(candidates).toEqual([{
      nodeId: 'loop', label: '窗边循环', url: '/loop.mp4', durationMs: 3200, source: 'imported',
    }]);
  });

  it('绑定和解绑同步播放地址与领域媒体状态', () => {
    const current = {
      description: '尾巴轻晃',
      productionNotes: '首尾连续',
      media: { source: 'placeholder' as const, status: 'missing' as const, version: 1 },
    };
    const bound = bindChoiceLoopPatch(current, {
      nodeId: 'loop', label: '循环', url: '/loop.mp4', durationMs: 3000, source: 'generated',
    });
    expect(bound.choiceLoopVideoUrl).toBe('/loop.mp4');
    expect(bound.storyChoiceLoop?.media).toMatchObject({ source: 'generated', status: 'ready', url: '/loop.mp4' });
    expect(clearChoiceLoopMediaPatch(bound.storyChoiceLoop).storyChoiceLoop?.media).toMatchObject({
      source: 'placeholder', status: 'missing',
    });
  });
});
