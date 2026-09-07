import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type StoryVariable } from '@/features/canvas/story/storyTypes';
import { compileStoryGroup } from '@/features/canvas/story/compileStoryGroup';

function group(id: string, storyVariables: StoryVariable[] = []): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 },
    data: { label: 'g', storyGroup: true, storyVariableDefinitions: storyVariables } } as CanvasNode;
}
function clip(id: string, parentId: string, url: string, start?: 'start'): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.video, parentId, position: { x: 0, y: 0 },
    data: { videoUrl: url, aspectRatio: '16:9', ...(start ? { storyRole: start } : {}) } } as CanvasNode;
}
function cedge(s: string, t: string, text: string, order: number): CanvasEdge {
  return { id: `${s}->${t}`, source: s, target: t, type: STORY_CHOICE_EDGE_TYPE, data: { choiceText: text, order } } as CanvasEdge;
}

describe('compileStoryGroup', () => {
  it('只编译该组成员及成员间的边，并带上该组状态', () => {
    const nodes = [
      group('g1', [{ name: 'fav', label: '好感', initial: 0 }]),
      clip('a', 'g1', 'a.mp4', 'start'),
      clip('b', 'g1', 'b.mp4'),
      // 另一组的节点,不该进来
      group('g2'),
      clip('x', 'g2', 'x.mp4', 'start'),
    ];
    const edges = [cedge('a', 'b', '去 b', 0)];
    const result = compileStoryGroup('g1', nodes, edges);
    expect(result.ink).toContain('VAR fav = 0');
    expect(result.ink).toContain('=== clip_a ===');
    expect(result.ink).toContain('=== clip_b ===');
    expect(result.ink).not.toContain('clip_x');
    expect(result.ink).toContain('-> clip_a'); // 起点
  });

  it('实时生成可从任意可达片段开始，同时保留完整故事供后续跳转', () => {
    const nodes = [
      group('g1'),
      clip('a', 'g1', 'a.mp4', 'start'),
      clip('b', 'g1', 'b.mp4'),
      clip('c', 'g1', 'c.mp4'),
    ];
    const edges = [cedge('a', 'b', '去 b', 0), cedge('b', 'c', '去 c', 0)];

    const result = compileStoryGroup('g1', nodes, edges, { entryNodeId: 'b' });

    expect(result.ink).toMatch(/-> clip_b\s+=== clip_a ===/);
    expect(result.ink).toContain('=== clip_c ===');
  });

  it('实时生成可单独播放尚未接入主线的孤立片段', () => {
    const nodes = [
      group('g1'),
      clip('a', 'g1', 'a.mp4', 'start'),
      clip('b', 'g1', 'b.mp4'),
      clip('orphan', 'g1', 'orphan.mp4'),
    ];

    const result = compileStoryGroup('g1', nodes, [cedge('a', 'b', '继续', 0)], {
      entryNodeId: 'orphan',
    });

    expect(result.ink).toMatch(/-> clip_orphan\s+=== clip_a ===/);
    expect(result.ink).toContain('=== clip_orphan ===');
  });

  it('空组(无视频成员)抛 StoryCompileError', () => {
    const nodes = [group('g1')];
    expect(() => compileStoryGroup('g1', nodes, [])).toThrow();
  });

  it('存在严重路径问题时拒绝生成试玩和发布产物', () => {
    const nodes = [group('g1'), clip('a', 'g1', 'a.mp4', 'start')];
    const loop = cedge('a', 'a', '', 0);
    loop.data = { ...loop.data, transitionMode: 'automatic' };

    expect(() => compileStoryGroup('g1', nodes, [loop])).toThrow(/严重问题/);
  });

  it('指向组外的分支不再静默忽略', () => {
    const nodes = [group('g1'), clip('a', 'g1', 'a.mp4', 'start'), group('g2'), clip('x', 'g2', 'x.mp4')];
    expect(() => compileStoryGroup('g1', nodes, [cedge('a', 'x', '跨组', 0)])).toThrow(/严重问题/);
  });
});
