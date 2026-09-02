import { describe, expect, it } from 'vitest';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type StoryVariableDefinition,
} from '@/features/canvas/domain/canvasNodes';
import type { StoryVariable } from '@/features/canvas/story/storyTypes';
import {
  selectGroupStoryVariables,
  selectStoryVariablesForEdgeSource,
} from '@/features/canvas/story/storyVariableSelectors';

function group(
  id: string,
  storyVariables?: StoryVariable[],
  storyVariableDefinitions?: StoryVariableDefinition[],
): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.group,
    position: { x: 0, y: 0 },
    data: {
      label: 'g',
      ...(storyVariables === undefined ? {} : { storyVariables }),
      ...(storyVariableDefinitions === undefined ? {} : { storyVariableDefinitions }),
    },
  } as CanvasNode;
}
function clip(id: string, parentId: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    parentId,
    position: { x: 0, y: 0 },
    data: { videoUrl: 'a.mp4', aspectRatio: '16:9' },
  } as CanvasNode;
}

describe('story variable selectors', () => {
  // 防 zustand selector 每次返回新 [] 触发无限重渲染("Maximum update depth exceeded")。
  it('无变量时返回稳定的同一空数组引用', () => {
    const nodes = [group('g1', undefined), clip('a', 'g1')];
    expect(selectGroupStoryVariables(nodes, 'g1')).toBe(selectGroupStoryVariables(nodes, 'g1'));
    expect(selectStoryVariablesForEdgeSource(nodes, 'a')).toBe(
      selectStoryVariablesForEdgeSource(nodes, 'a'),
    );
  });

  it('source 节点不在任何故事组时返回稳定空数组', () => {
    const nodes = [clip('a', '')];
    expect(selectStoryVariablesForEdgeSource(nodes, 'a')).toBe(
      selectStoryVariablesForEdgeSource(nodes, 'a'),
    );
  });

  it('有变量时返回该组的实际数组', () => {
    const vars: StoryVariable[] = [{ name: 'fav', label: '好感', initial: 0 }];
    const nodes = [group('g1', vars), clip('a', 'g1')];
    expect(selectGroupStoryVariables(nodes, 'g1')).toBe(vars);
    expect(selectStoryVariablesForEdgeSource(nodes, 'a')).toBe(vars);
  });

  it('完整变量定义存在时优先于兼容字段', () => {
    const legacy: StoryVariable[] = [{ name: 'fav', label: '旧好感', initial: 0 }];
    const definitions: StoryVariableDefinition[] = [
      { name: 'fav', label: '新好感', initial: 5, minimum: 0, maximum: 10 },
    ];
    const nodes = [group('g1', legacy, definitions), clip('a', 'g1')];

    expect(selectGroupStoryVariables(nodes, 'g1')).toBe(definitions);
    expect(selectStoryVariablesForEdgeSource(nodes, 'a')).toBe(definitions);
  });
});
