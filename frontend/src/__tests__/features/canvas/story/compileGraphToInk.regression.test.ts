import { afterEach, expect, it } from 'vitest';
import { Compiler } from 'inkjs/full';
import { compileGraphToInk } from '@/features/canvas/story/compileGraphToInk';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, normalizeStoryChoiceInteraction, type StoryChoiceEdgeData } from '@/features/canvas/story/storyTypes';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';

function node(id: string, start = false): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: {
      videoUrl: `${id}.mp4`,
      aspectRatio: '16:9',
      ...(start ? { storyRole: 'start', choiceTimeLimitSec: 5 } : {}),
    },
  } as CanvasNode;
}
function edge(target: string, order: number, extra: Partial<StoryChoiceEdgeData> = {}): CanvasEdge {
  return {
    id: `e${order}`,
    source: 'start',
    target,
    type: STORY_CHOICE_EDGE_TYPE,
    data: { choiceText: target, order, ...extra },
  } as CanvasEdge;
}

afterEach(() => useStoryRuntimeStore.getState().exitPlay());

it.each([false, true])('resolves defaults after conditions filter choices (hidden default: %s)', hiddenDefault => {
  const condition = { var: 'x', op: '>' as const, value: 0 };
  const compiled = compileGraphToInk([node('start', true), node('hidden'), node('default'), node('other')], [edge('hidden', 0, { condition }), edge('default', 1, { isDefault: true, ...(hiddenDefault ? { condition } : {}) }), edge('other', 2)], [{ name: 'x', label: 'X', initial: 0 }]);
  useStoryRuntimeStore.getState().enterPlay(compiled);
  const state = useStoryRuntimeStore.getState();
  expect(state.currentDefaultChoiceIndex).toBe(hiddenDefault ? null : 0);
  state.choose(state.currentDefaultChoiceIndex ?? state.currentChoices[0].index);
  expect(useStoryRuntimeStore.getState().currentNodeId).toBe(hiddenDefault ? 'other' : 'default');
});

it.each(['查看 # 详情', '打开 https://example.com', '文本 /* 原样 */ 显示', '显示 {1+1}', '[打开] -> 继续', 'A | B < C > D', '路径 \\ 选项 * + ~', '第一行\n第二行'])('preserves literal choice text %s', text => {
  const compiled = compileGraphToInk([node('start', true), node('end')], [edge('end', 0, { choiceText: text, feedbackText: '反馈', interaction: { transition: 'cut' } })]);
  useStoryRuntimeStore.getState().enterPlay(compiled);
  const state = useStoryRuntimeStore.getState();
  expect(state.error).toBeNull();
  expect(state.currentChoices[0]).toMatchObject({ text: text.replace(/\n/g, ' '), feedbackText: '反馈', interaction: { transition: 'cut' } });
});

it('compiles distinct IDs including escape-like IDs and routes each choice correctly', () => {
  const ids = ['a-b', 'a_b', 'a_2d_b', '中文', '日本'];
  const compiled = compileGraphToInk([node('start', true), ...ids.map(id => node(id))], ids.map((id, i) => edge(id, i)));
  expect(new Set(Object.values(compiled.knotByNodeId)).size).toBe(ids.length + 1);
  for (let index = 0; index < ids.length; index++) {
    const story = new Compiler(compiled.ink).Compile();
    story.Continue();
    story.ChooseChoiceIndex(index);
    story.Continue();
    expect(story.currentTags).toContain(`clip: ${ids[index]}`);
  }
});

it.each(['cut', 'flash'] as const)('preserves ordinary click transition %s', transition => {
  const compiled = compileGraphToInk([node('start', true), node('end')], [edge('end', 0, { interaction: { presentation: 'overlay', trigger: 'click', transition } })]);
  useStoryRuntimeStore.getState().enterPlay(compiled);
  expect(normalizeStoryChoiceInteraction(useStoryRuntimeStore.getState().currentChoices[0].interaction).transition).toBe(transition);
});

it('retains positional defaults for older compiled stories without tags', () => {
  const compiled = compileGraphToInk(
    [node('start', true), node('first'), node('default')],
    [edge('first', 0), edge('default', 1, { isDefault: true })],
  );
  compiled.ink = compiled.ink.replace(/ # choice-default: (true|false)/g, '');
  useStoryRuntimeStore.getState().enterPlay(compiled);
  expect(useStoryRuntimeStore.getState().currentDefaultChoiceIndex).toBe(1);
});
