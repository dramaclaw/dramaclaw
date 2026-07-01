import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import type { StoryVariable } from '@/features/canvas/story/storyTypes';
import { compileGraphToInk, StoryCompileError } from '@/features/canvas/story/compileGraphToInk';

function videoNode(id: string, videoUrl: string | null, storyRole?: 'start'): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: { videoUrl, aspectRatio: '16:9', ...(storyRole ? { storyRole } : {}) },
  } as CanvasNode;
}

function choiceEdge(source: string, target: string, choiceText: string, order: number): CanvasEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: STORY_CHOICE_EDGE_TYPE,
    data: { choiceText, order },
  } as CanvasEdge;
}

describe('compileGraphToInk', () => {
  it('单起点两选项:生成入口 divert、两个 knot、叶子补 -> END', () => {
    const nodes = [
      videoNode('intro', 'intro.mp4', 'start'),
      videoNode('meet', 'meet.mp4'),
      videoNode('awk', 'awk.mp4'),
    ];
    const edges = [
      choiceEdge('intro', 'meet', '先自我介绍', 0),
      choiceEdge('intro', 'awk', '直接坐下', 1),
    ];

    const result = compileGraphToInk(nodes, edges);

    expect(result.ink).toContain('-> clip_intro');
    expect(result.ink).toContain('=== clip_intro ===');
    expect(result.ink).toContain('# clip: intro');
    expect(result.ink).toContain('+ [先自我介绍]');
    expect(result.ink).toContain('-> clip_meet');
    expect(result.ink).toContain('+ [直接坐下]');
    expect(result.ink).toContain('-> clip_awk');
    expect(result.ink).toContain('-> END');
    expect(result.clipByNodeId.intro).toBe('intro.mp4');
    expect(result.knotByNodeId.intro).toBe('clip_intro');
  });

  it('选项按 order 升序排列', () => {
    const nodes = [
      videoNode('a', 'a.mp4', 'start'),
      videoNode('b', 'b.mp4'),
      videoNode('c', 'c.mp4'),
    ];
    const edges = [
      choiceEdge('a', 'c', '第二项', 5),
      choiceEdge('a', 'b', '第一项', 1),
    ];
    const ink = compileGraphToInk(nodes, edges).ink;
    expect(ink.indexOf('第一项')).toBeLessThan(ink.indexOf('第二项'));
  });

  it('只编译从起点可达的节点,忽略孤立节点', () => {
    const nodes = [
      videoNode('a', 'a.mp4', 'start'),
      videoNode('b', 'b.mp4'),
      videoNode('orphan', 'orphan.mp4'),
    ];
    const edges = [choiceEdge('a', 'b', '去 b', 0)];
    const ink = compileGraphToInk(nodes, edges).ink;
    expect(ink).toContain('=== clip_a ===');
    expect(ink).toContain('=== clip_b ===');
    expect(ink).not.toContain('clip_orphan');
  });

  it('无起点节点时抛出结构化错误,code 为 no_start', () => {
    const nodes = [videoNode('a', 'a.mp4')];
    expect(() => compileGraphToInk(nodes, [])).toThrow(StoryCompileError);
    try {
      compileGraphToInk(nodes, []);
    } catch (err) {
      expect((err as StoryCompileError).code).toBe('no_start');
    }
  });

  it('起点 videoUrl 为 null 时 clipByNodeId 为空串', () => {
    const nodes = [videoNode('a', null, 'start')];
    const result = compileGraphToInk(nodes, []);
    expect(result.clipByNodeId['a']).toBe('');
  });

  it('自环选项边不死循环,只生成一个 knot', () => {
    const nodes = [videoNode('a', 'a.mp4', 'start')];
    const edges = [choiceEdge('a', 'a', '回头', 0)];
    const result = compileGraphToInk(nodes, edges);
    expect((result.ink.match(/=== clip_a ===/g) ?? []).length).toBe(1);
  });

  it('无显式起点但有唯一树根时,自动推断根为起点', () => {
    const nodes = [
      videoNode('root', 'root.mp4'),
      videoNode('b', 'b.mp4'),
      videoNode('c', 'c.mp4'),
    ];
    const edges = [
      choiceEdge('root', 'b', '选 b', 0),
      choiceEdge('root', 'c', '选 c', 1),
    ];
    const result = compileGraphToInk(nodes, edges);
    expect(result.ink).toContain('-> clip_root');
    expect(result.knotByNodeId['root']).toBe('clip_root');
  });

  it('显式起点优先于推断的根', () => {
    const nodes = [
      videoNode('root', 'root.mp4'),
      videoNode('mid', 'mid.mp4', 'start'),
    ];
    const edges = [choiceEdge('root', 'mid', '去 mid', 0)];
    const result = compileGraphToInk(nodes, edges);
    expect(result.ink).toContain('-> clip_mid');
  });

  it('存在多个根(多棵树)时仍抛 no_start,要求显式指定', () => {
    const nodes = [
      videoNode('r1', 'r1.mp4'),
      videoNode('a', 'a.mp4'),
      videoNode('r2', 'r2.mp4'),
      videoNode('b', 'b.mp4'),
    ];
    const edges = [choiceEdge('r1', 'a', '走', 0), choiceEdge('r2', 'b', '走', 0)];
    try {
      compileGraphToInk(nodes, edges);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as StoryCompileError).code).toBe('no_start');
    }
  });
});

function richEdge(
  source: string,
  target: string,
  choiceText: string,
  order: number,
  extra: { condition?: { var: string; op: '>=' | '<=' | '==' | '>' | '<'; value: number }; effects?: { var: string; delta: number }[] },
): CanvasEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: STORY_CHOICE_EDGE_TYPE,
    data: { choiceText, order, ...extra },
  } as CanvasEdge;
}

function groupEdge(
  source: string,
  target: string,
  choiceText: string,
  order: number,
  join: 'and' | 'or',
  items: { var: string; op: '>=' | '<=' | '==' | '>' | '<'; value: number }[],
): CanvasEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: STORY_CHOICE_EDGE_TYPE,
    data: { choiceText, order, condition: { join, items } },
  } as CanvasEdge;
}

describe('compileGraphToInk variables', () => {
  const vars: StoryVariable[] = [{ name: 'fav', label: '好感度', initial: 0 }];

  it('为每个变量生成 VAR 声明', () => {
    const nodes = [videoNode('a', 'a.mp4', 'start')];
    const result = compileGraphToInk(nodes, [], vars);
    expect(result.ink).toContain('VAR fav = 0');
  });

  it('带条件的选项生成 + {var op value}', () => {
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('b', 'b.mp4')];
    const edges = [richEdge('a', 'b', '去 b', 0, { condition: { var: 'fav', op: '>=', value: 3 } })];
    const result = compileGraphToInk(nodes, edges, vars);
    expect(result.ink).toContain('+ {fav >= 3} [去 b]');
    expect(result.ink).toContain('-> clip_b');
  });

  it('带效果的选项生成 ~ var += delta', () => {
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('b', 'b.mp4')];
    const edges = [richEdge('a', 'b', '去 b', 0, { effects: [{ var: 'fav', delta: 2 }] })];
    const result = compileGraphToInk(nodes, edges, vars);
    expect(result.ink).toContain('~ fav += 2');
  });

  it('引用未注册变量的条件/效果被静默跳过且记 warning', () => {
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('b', 'b.mp4')];
    const edges = [
      richEdge('a', 'b', '去 b', 0, {
        condition: { var: 'ghost', op: '>=', value: 1 },
        effects: [{ var: 'ghost', delta: 1 }],
      }),
    ];
    const result = compileGraphToInk(nodes, edges, vars);
    expect(result.ink).not.toContain('ghost');
    expect(result.ink).toContain('+ [去 b]'); // 退化为无条件无效果
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('不传 variables 时与 v1 行为一致(向后兼容)', () => {
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('b', 'b.mp4')];
    const edges = [richEdge('a', 'b', '去 b', 0, {})];
    const result = compileGraphToInk(nodes, edges);
    expect(result.ink).toContain('+ [去 b]');
    expect(result.warnings).toEqual([]);
  });

  it('访问计数叶子编译成 { clip_<id> op n }', () => {
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('secret', 's.mp4'), videoNode('b', 'b.mp4')];
    const edges: CanvasEdge[] = [
      { id: 'a->secret', source: 'a', target: 'secret', type: STORY_CHOICE_EDGE_TYPE, data: { choiceText: '去密室', order: 0 } } as CanvasEdge,
      { id: 'secret->b', source: 'secret', target: 'b', type: STORY_CHOICE_EDGE_TYPE, data: { choiceText: '回去', order: 0 } } as CanvasEdge,
      { id: 'a->b', source: 'a', target: 'b', type: STORY_CHOICE_EDGE_TYPE,
        data: { choiceText: '只有去过密室才出现', order: 1, condition: { visitedNodeId: 'secret', op: '>=', value: 1 } } } as CanvasEdge,
    ];
    const ink = compileGraphToInk(nodes, edges).ink;
    expect(ink).toContain('{clip_secret >= 1} [只有去过密室才出现]');
  });

  it('访问叶子与变量叶子混在 AND 组', () => {
    const vars2: StoryVariable[] = [{ name: 'favor', label: '好感', initial: 0 }];
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('secret', 's.mp4'), videoNode('b', 'b.mp4')];
    const edges: CanvasEdge[] = [
      { id: 'a->secret', source: 'a', target: 'secret', type: STORY_CHOICE_EDGE_TYPE, data: { choiceText: '去', order: 0 } } as CanvasEdge,
      { id: 'secret->b', source: 'secret', target: 'b', type: STORY_CHOICE_EDGE_TYPE, data: { choiceText: '回', order: 0 } } as CanvasEdge,
      { id: 'a->b', source: 'a', target: 'b', type: STORY_CHOICE_EDGE_TYPE, data: { choiceText: '混合', order: 1,
        condition: { join: 'and', items: [{ var: 'favor', op: '>=', value: 5 }, { visitedNodeId: 'secret', op: '>=', value: 1 }] } } } as CanvasEdge,
    ];
    const ink = compileGraphToInk(nodes, edges, vars2).ink;
    expect(ink).toContain('{favor >= 5 && clip_secret >= 1} [混合]');
  });

  it('访问叶子指向不可达/组外节点 → 跳过该叶子 + warning', () => {
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('b', 'b.mp4')];
    const edges: CanvasEdge[] = [
      { id: 'a->b', source: 'a', target: 'b', type: STORY_CHOICE_EDGE_TYPE,
        data: { choiceText: '去 b', order: 0, condition: { visitedNodeId: 'ghost', op: '>=', value: 1 } } } as CanvasEdge,
    ];
    const result = compileGraphToInk(nodes, edges);
    expect(result.ink).not.toContain('clip_ghost');
    expect(result.ink).toContain('+ [去 b]');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('复合 AND 条件组生成 { a >= 5 && b >= 0 }', () => {
    const vars2: StoryVariable[] = [
      { name: 'fav', label: '好感度', initial: 0 },
      { name: 'trust', label: '信任', initial: 0 },
    ];
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('b', 'b.mp4')];
    const edges = [groupEdge('a', 'b', '去 b', 0, 'and', [
      { var: 'fav', op: '>=', value: 5 },
      { var: 'trust', op: '>=', value: 0 },
    ])];
    const result = compileGraphToInk(nodes, edges, vars2);
    expect(result.ink).toContain('+ {fav >= 5 && trust >= 0} [去 b]');
  });

  it('复合 OR 条件组生成 { a >= 5 || b < 1 }', () => {
    const vars2: StoryVariable[] = [
      { name: 'fav', label: '好感度', initial: 0 },
      { name: 'trust', label: '信任', initial: 0 },
    ];
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('b', 'b.mp4')];
    const edges = [groupEdge('a', 'b', '去 b', 0, 'or', [
      { var: 'fav', op: '>=', value: 5 },
      { var: 'trust', op: '<', value: 1 },
    ])];
    const result = compileGraphToInk(nodes, edges, vars2);
    expect(result.ink).toContain('+ {fav >= 5 || trust < 1} [去 b]');
  });

  it('组里任一叶子引用未注册变量 → 整组丢弃 + warning', () => {
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('b', 'b.mp4')];
    const edges = [groupEdge('a', 'b', '去 b', 0, 'and', [
      { var: 'fav', op: '>=', value: 5 },
      { var: 'ghost', op: '>=', value: 1 },
    ])];
    const result = compileGraphToInk(nodes, edges, vars);
    expect(result.ink).not.toContain('ghost');
    expect(result.ink).toContain('+ [去 b]'); // 整组丢弃,退化为无条件
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('限时:输出 choiceTimeByNodeId + defaultChoiceIndexByNodeId(默认项排序后位置)', () => {
    const start = {
      id: 'intro',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: { videoUrl: 'i.mp4', aspectRatio: '16:9', storyRole: 'start', choiceTimeLimitSec: 4 },
    } as CanvasNode;
    const nodes = [start, videoNode('meet', 'm.mp4'), videoNode('awk', 'a.mp4')];
    const defaultEdge = {
      id: 'intro->awk',
      source: 'intro',
      target: 'awk',
      type: STORY_CHOICE_EDGE_TYPE,
      data: { choiceText: '直接坐下', order: 1, isDefault: true },
    } as CanvasEdge;
    const edges = [choiceEdge('intro', 'meet', '先自我介绍', 0), defaultEdge];

    const result = compileGraphToInk(nodes, edges);
    expect(result.choiceTimeByNodeId.intro).toBe(4);
    // 默认项 order=1,排序后位于第 1 位(0-based)→ inkjs choice index 1
    expect(result.defaultChoiceIndexByNodeId.intro).toBe(1);
    // 无限时节点不进表
    expect(result.choiceTimeByNodeId.meet).toBeUndefined();
  });

  it('无默认/无限时:两张表为空', () => {
    const nodes = [videoNode('a', 'a.mp4', 'start'), videoNode('b', 'b.mp4')];
    const edges = [choiceEdge('a', 'b', '去 b', 0)];
    const result = compileGraphToInk(nodes, edges);
    expect(result.choiceTimeByNodeId).toEqual({});
    expect(result.defaultChoiceIndexByNodeId).toEqual({});
  });

  it('endingByNodeId 仅含叶子结局:title=旁白,label=endingLabel', () => {
    const start = {
      id: 'a',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: { videoUrl: 'a.mp4', aspectRatio: '16:9', storyRole: 'start', narration: '开场' },
    } as CanvasNode;
    const leaf = {
      id: 'b',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: { videoUrl: 'b.mp4', aspectRatio: '16:9', narration: '宠冠后宫', endingLabel: 'GE' },
    } as CanvasNode;
    const result = compileGraphToInk([start, leaf], [choiceEdge('a', 'b', '去 b', 0)]);
    expect(result.endingByNodeId.b).toEqual({ title: '宠冠后宫', label: 'GE' });
    // 非叶子(有选项)不进结局表
    expect(result.endingByNodeId.a).toBeUndefined();
  });
});
