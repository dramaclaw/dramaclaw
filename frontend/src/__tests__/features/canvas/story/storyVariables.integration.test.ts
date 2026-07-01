import { describe, expect, it } from 'vitest';
import { Compiler } from 'inkjs/full';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type StoryVariable } from '@/features/canvas/story/storyTypes';
import { compileGraphToInk } from '@/features/canvas/story/compileGraphToInk';

function v(id: string, url: string, start?: 'start'): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: { videoUrl: url, aspectRatio: '16:9', ...(start ? { storyRole: start } : {}) },
  } as CanvasNode;
}
function edge(id: string, s: string, t: string, text: string, order: number, extra: object): CanvasEdge {
  return { id, source: s, target: t, type: STORY_CHOICE_EDGE_TYPE, data: { choiceText: text, order, ...extra } } as CanvasEdge;
}

describe('变量+条件 端到端(inkjs)', () => {
  it('效果累加好感度后,阈值条件选项才出现', () => {
    const vars: StoryVariable[] = [{ name: 'fav', label: '好感度', initial: 0 }];
    // start --(夸她, fav+3)--> mid ; start --(沉默)--> mid2
    // mid --(表白, 需 fav>=3)--> good ; mid --(走开)--> bad
    const nodes = [v('start', 's.mp4', 'start'), v('mid', 'm.mp4'), v('mid2', 'm2.mp4'), v('good', 'g.mp4'), v('bad', 'b.mp4')];
    const edges = [
      edge('e1', 'start', 'mid', '夸她', 0, { effects: [{ var: 'fav', delta: 3 }] }),
      edge('e2', 'start', 'mid2', '沉默', 1, {}),
      edge('e3', 'mid', 'good', '表白', 0, { condition: { var: 'fav', op: '>=', value: 3 } }),
      edge('e4', 'mid', 'bad', '走开', 1, {}),
    ];
    const { ink } = compileGraphToInk(nodes, edges, vars);
    const story = new Compiler(ink).Compile();

    story.Continue(); // start
    expect(story.currentChoices.map((c) => c.text)).toEqual(['夸她', '沉默']);
    story.ChooseChoiceIndex(0); // 夸她 → fav=3 → mid
    story.Continue();
    // fav>=3 满足 → 「表白」可见
    expect(story.currentChoices.map((c) => c.text)).toEqual(['表白', '走开']);
    // inkjs 读变量值:story.variablesState['fav'] 走 index signature proxy,与 story.variablesState.$('fav') 等价
    expect(story.variablesState['fav']).toBe(3);
  });

  it('好感度不足时,阈值条件选项被隐藏', () => {
    const vars: StoryVariable[] = [{ name: 'fav', label: '好感度', initial: 0 }];
    const nodes = [v('start', 's.mp4', 'start'), v('mid', 'm.mp4'), v('mid2', 'm2.mp4'), v('good', 'g.mp4'), v('bad', 'b.mp4')];
    const edges = [
      edge('e1', 'start', 'mid', '夸她', 0, { effects: [{ var: 'fav', delta: 1 }] }),
      edge('e2', 'start', 'mid2', '沉默', 1, {}),
      edge('e3', 'mid', 'good', '表白', 0, { condition: { var: 'fav', op: '>=', value: 3 } }),
      edge('e4', 'mid', 'bad', '走开', 1, {}),
    ];
    const { ink } = compileGraphToInk(nodes, edges, vars);
    const story = new Compiler(ink).Compile();
    story.Continue();
    story.ChooseChoiceIndex(0); // fav=1
    story.Continue();
    expect(story.currentChoices.map((c) => c.text)).toEqual(['走开']); // 表白被隐藏
  });
});
