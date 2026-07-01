import { describe, expect, it } from 'vitest';
import { buildStoryTree } from '@/features/canvas/story/buildStoryTree';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type StoryConditionExpr } from '@/features/canvas/story/storyTypes';

function vnode(
  id: string,
  opts: { start?: boolean; video?: string | null; ending?: string; narration?: string; timed?: number } = {},
): CanvasNode {
  return {
    id, type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
    data: {
      displayName: id,
      videoUrl: opts.video === undefined ? 'v.mp4' : opts.video,
      aspectRatio: '16:9',
      ...(opts.start ? { storyRole: 'start' } : {}),
      ...(opts.ending ? { endingLabel: opts.ending } : {}),
      ...(opts.narration ? { narration: opts.narration } : {}),
      ...(opts.timed ? { choiceTimeLimitSec: opts.timed } : {}),
    },
  } as CanvasNode;
}
function cedge(
  s: string, t: string, text: string, order: number,
  opts: { condition?: StoryConditionExpr } = {},
): CanvasEdge {
  return {
    id: `${s}->${t}`, source: s, target: t, type: STORY_CHOICE_EDGE_TYPE,
    data: { choiceText: text, order, ...(opts.condition ? { condition: opts.condition } : {}) },
  } as CanvasEdge;
}

describe('buildStoryTree', () => {
  it('线性故事 → 逐层嵌套,depth 递增', () => {
    const members = [vnode('a', { start: true }), vnode('b'), vnode('c', { ending: 'GE' })];
    const edges = [cedge('a', 'b', '去b', 0), cedge('b', 'c', '去c', 0)];
    const m = buildStoryTree(members, edges, []);
    expect(m.noStart).toBe(false);
    expect(m.root?.nodeId).toBe('a');
    expect(m.root?.depth).toBe(0);
    expect(m.root?.children[0].nodeId).toBe('b');
    expect(m.root?.children[0].depth).toBe(1);
    expect(m.root?.children[0].children[0].nodeId).toBe('c');
    expect(m.root?.children[0].children[0].depth).toBe(2);
  });

  it('分支按 edge order 排序,incomingChoiceText 正确', () => {
    const members = [vnode('a', { start: true }), vnode('b', { ending: 'GE' }), vnode('c', { ending: 'BE' })];
    const edges = [cedge('a', 'c', '去c', 1), cedge('a', 'b', '去b', 0)];
    const m = buildStoryTree(members, edges, []);
    expect(m.root?.children.map((r) => r.nodeId)).toEqual(['b', 'c']);
    expect(m.root?.children[0].incomingChoiceText).toBe('去b');
  });

  it('DAG 汇合 → 第二次到达标 repeated 且不再展开', () => {
    const members = [vnode('a', { start: true }), vnode('b'), vnode('c'), vnode('d', { ending: 'GE' })];
    const edges = [cedge('a', 'b', '去b', 0), cedge('a', 'c', '去c', 1), cedge('b', 'd', 'b到d', 0), cedge('c', 'd', 'c到d', 0)];
    const m = buildStoryTree(members, edges, []);
    const b = m.root!.children.find((r) => r.nodeId === 'b')!;
    const c = m.root!.children.find((r) => r.nodeId === 'c')!;
    expect(b.children[0].nodeId).toBe('d');
    expect(b.children[0].repeated).toBe(false);
    expect(c.children[0].nodeId).toBe('d');
    expect(c.children[0].repeated).toBe(true);
    expect(c.children[0].children).toHaveLength(0);
  });

  it('结局叶子 → isEnding + endingLabel/Title', () => {
    const members = [vnode('a', { start: true }), vnode('b', { ending: 'GE', narration: '宠冠后宫' })];
    const edges = [cedge('a', 'b', '去b', 0)];
    const m = buildStoryTree(members, edges, []);
    const b = m.root!.children[0];
    expect(b.isEnding).toBe(true);
    expect(b.endingLabel).toBe('GE');
    expect(b.endingTitle).toBe('宠冠后宫');
    expect(m.root!.isEnding).toBe(false);
  });

  it('缺视频节点 → 行 issues 含 missing_video', () => {
    const members = [vnode('a', { start: true }), vnode('b', { video: null, ending: 'GE' })];
    const edges = [cedge('a', 'b', '去b', 0)];
    const m = buildStoryTree(members, edges, []);
    expect(m.root!.children[0].issues).toContain('missing_video');
  });

  it('不可达节点 → 进 orphans,不在 root 树内', () => {
    const members = [vnode('a', { start: true }), vnode('b', { ending: 'GE' }), vnode('lonely', { ending: 'BE' })];
    const edges = [cedge('a', 'b', '去b', 0)];
    const m = buildStoryTree(members, edges, []);
    expect(m.orphans.map((o) => o.nodeId)).toContain('lonely');
    expect(m.orphans.find((o) => o.nodeId === 'lonely')?.issues).toContain('unreachable');
  });

  it('多起点 → noStart,root 为 null,orphans 为全部成员', () => {
    const members = [vnode('a', { start: true }), vnode('b', { start: true })];
    const edges: CanvasEdge[] = [];
    const m = buildStoryTree(members, edges, []);
    expect(m.noStart).toBe(true);
    expect(m.root).toBeNull();
    expect(m.orphans.map((o) => o.nodeId).sort()).toEqual(['a', 'b']);
  });

  it('限时源节点 → isTimedSource;带条件选项 → 子行 hasCondition', () => {
    const cond: StoryConditionExpr = { var: 'fav', op: '>=', value: 3 };
    const members = [vnode('a', { start: true, timed: 5 }), vnode('b', { ending: 'GE' })];
    const edges = [cedge('a', 'b', '去b', 0, { condition: cond })];
    const m = buildStoryTree(members, edges, [{ name: 'fav', label: '好感', initial: 0 }]);
    expect(m.root!.isTimedSource).toBe(true);
    expect(m.root!.children[0].hasCondition).toBe(true);
  });
});
