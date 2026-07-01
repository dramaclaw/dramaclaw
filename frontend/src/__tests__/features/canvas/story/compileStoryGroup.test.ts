import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type StoryVariable } from '@/features/canvas/story/storyTypes';
import { compileStoryGroup } from '@/features/canvas/story/compileStoryGroup';

function group(id: string, storyVariables: StoryVariable[] = []): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 },
    data: { label: 'g', storyGroup: true, storyVariables } } as CanvasNode;
}
function clip(id: string, parentId: string, url: string, start?: 'start'): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.video, parentId, position: { x: 0, y: 0 },
    data: { videoUrl: url, aspectRatio: '16:9', ...(start ? { storyRole: start } : {}) } } as CanvasNode;
}
function cedge(s: string, t: string, text: string, order: number): CanvasEdge {
  return { id: `${s}->${t}`, source: s, target: t, type: STORY_CHOICE_EDGE_TYPE, data: { choiceText: text, order } } as CanvasEdge;
}

describe('compileStoryGroup', () => {
  it('只编译该组成员 + 成员间的边,带该组变量', () => {
    const nodes = [
      group('g1', [{ name: 'fav', label: '好感', initial: 0 }]),
      clip('a', 'g1', 'a.mp4', 'start'),
      clip('b', 'g1', 'b.mp4'),
      // 另一组的节点,不该进来
      group('g2'),
      clip('x', 'g2', 'x.mp4', 'start'),
    ];
    const edges = [cedge('a', 'b', '去 b', 0), cedge('a', 'x', '跨组(忽略)', 1)];
    const result = compileStoryGroup('g1', nodes, edges);
    expect(result.ink).toContain('VAR fav = 0');
    expect(result.ink).toContain('=== clip_a ===');
    expect(result.ink).toContain('=== clip_b ===');
    expect(result.ink).not.toContain('clip_x'); // 跨组边/外组节点被忽略
    expect(result.ink).toContain('-> clip_a'); // 起点
  });

  it('空组(无视频成员)抛 StoryCompileError', () => {
    const nodes = [group('g1')];
    expect(() => compileStoryGroup('g1', nodes, [])).toThrow();
  });
});
