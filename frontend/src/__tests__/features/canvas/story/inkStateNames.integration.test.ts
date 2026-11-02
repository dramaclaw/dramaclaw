import { afterEach, describe, expect, it } from 'vitest';
import { Compiler, Story } from 'inkjs/full';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { compileStoryGroup } from '@/features/canvas/story/compileStoryGroup';
import { stateNameForVariable } from '@/features/canvas/story/inkNames';
import { compilePlayback, type PlaybackSnapshot } from '@/features/canvas/story/publication';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';

function canvas(variable: string, flag: string) {
  const nodes = [
    { id: 'g', type: 'groupNode', position: { x: 0, y: 0 }, data: {
      storyGroup: true,
      storyVariableDefinitions: [{ name: variable, label: 'Score', initial: 0 }],
      storyFlags: [{ name: flag, label: 'Key', initial: false }],
    } },
    ...['start', 'gate', 'end'].map(id => ({
      id, type: 'videoNode', parentId: 'g', position: { x: 0, y: 0 }, data: {
        videoUrl: `${id}.mp4`,
        ...(id === 'start' ? { storyRole: 'start' } : {}),
        ...(id === 'end' ? { endingLabel: 'END' } : {}),
      },
    })),
  ] as CanvasNode[];
  const edges = [
    { id: 'loop', source: 'start', target: 'start', type: 'storyChoiceEdge', data: {
      choiceText: 'Take key', order: 0,
      condition: { visitedNodeId: 'start', op: '==', value: 1 },
      effects: [{ var: variable, delta: 1 }, { flag, value: true }],
    } },
    { id: 'continue', source: 'start', target: 'gate', type: 'storyChoiceEdge', data: {
      choiceText: 'Continue', order: 1,
      condition: { join: 'and', items: [
        { var: variable, op: '>=', value: 1 }, { flag, value: true },
        { visitedNodeId: 'start', op: '>=', value: 2 },
      ] },
    } },
    { id: 'automatic', source: 'gate', target: 'end', type: 'storyChoiceEdge', data: {
      choiceText: '', transitionMode: 'automatic', order: 0,
      condition: { join: 'and', items: [{ var: variable, op: '==', value: 1 }, { flag, value: true }] },
      effects: [{ var: variable, delta: 2 }, { flag, value: false }],
    } },
    { id: 'fallback', source: 'gate', target: 'end', type: 'storyChoiceEdge', data: {
      choiceText: '', transitionMode: 'automatic', order: 1,
    } },
  ] as CanvasEdge[];
  return { nodes, edges };
}

const names = [
  ['clip_start', 'clip_end'],
  ['END', 'temp'],
  ['clip_5f_start', 'true'],
  ['reenter_clip_start', 'state_clip_start'],
];

afterEach(() => useStoryRuntimeStore.getState().exitPlay());

describe('Ink state namespaces', () => {
  it.each(names)('plays and restores state for variable %s and flag %s', (variable, flag) => {
    const { nodes, edges } = canvas(variable, flag);
    const compiled = compileStoryGroup('g', nodes, edges);
    const errors: string[] = [];
    let story = new Compiler(compiled.ink).Compile();
    story.onError = message => errors.push(message);
    const advance = () => {
      const ids: string[] = [];
      while (story.canContinue) {
        expect(ids.length).toBeLessThan(20);
        story.Continue();
        ids.push(...(story.currentTags ?? []).filter(tag => tag.startsWith('clip:')).map(tag => tag.slice(5).trim()));
      }
      return ids;
    };
    expect(advance()).toEqual(['start']);
    expect(story.currentChoices.map(choice => choice.text)).toEqual(['Take key']);
    story.ChooseChoiceIndex(0);
    expect(advance()).toEqual(['start']);
    expect(story.currentChoices.map(choice => choice.text)).toEqual(['Continue']);
    // The exported player restores this same compiled JSON and state.
    const saved = story.state.toJson();
    story = new Story(story.ToJson()!);
    story.onError = message => errors.push(message);
    story.state.LoadJson(saved);
    story.ChooseChoiceIndex(0);
    expect(advance()).toEqual(['gate', 'end']);
    expect(story.variablesState!.$(stateNameForVariable(variable))).toBe(3);
    expect(story.variablesState!.$(stateNameForVariable(flag))).toBe(false);
    expect(errors).toEqual([]);
    expect(nodes[0].data.storyVariableDefinitions).toEqual([{ name: variable, label: 'Score', initial: 0 }]);
  });

  it('keeps colliding and escape-looking authored names distinct in the same story', () => {
    const { nodes, edges } = canvas('clip_start', 'clip_end');
    nodes[0].data.storyVariableDefinitions = [
      { name: 'clip_start', label: 'Score', initial: 0 },
      { name: 'clip_5f_start', label: 'Other', initial: 7 },
      { name: 'state_clip_start', label: 'Third', initial: 9 },
    ];
    const compiled = compileStoryGroup('g', nodes, edges);
    const story = new Compiler(compiled.ink).Compile();
    story.Continue();
    story.ChooseChoiceIndex(0);
    story.Continue();
    expect(story.variablesState!.$(stateNameForVariable('clip_start'))).toBe(1);
    expect(story.variablesState!.$(stateNameForVariable('clip_5f_start'))).toBe(7);
    expect(story.variablesState!.$(stateNameForVariable('state_clip_start'))).toBe(9);
  });

  it('plays the publication snapshot through the shared runtime with colliding names', () => {
    const { nodes, edges } = canvas('clip_start', 'clip_end');
    const compiled = compilePlayback({ groupId: 'g', nodes, edges } as PlaybackSnapshot);
    useStoryRuntimeStore.getState().enterPlay(compiled, { embedded: true });
    expect(useStoryRuntimeStore.getState().error).toBeNull();
    useStoryRuntimeStore.getState().choose(0);
    expect(useStoryRuntimeStore.getState().currentChoices.map(choice => choice.text)).toEqual(['Continue']);
    useStoryRuntimeStore.getState().choose(0);
    expect(useStoryRuntimeStore.getState().currentNodeId).toBe('gate');
    useStoryRuntimeStore.getState().advanceAutomatic();
    expect(useStoryRuntimeStore.getState().currentNodeId).toBe('end');
    expect(useStoryRuntimeStore.getState().phase).toBe('ended');
  });
});
