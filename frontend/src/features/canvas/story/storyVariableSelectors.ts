import type {
  CanvasNode,
  StoryVariableDefinition,
} from '@/features/canvas/domain/canvasNodes';
import type { StoryFlag, StoryVariable } from './storyTypes';

/**
 * 稳定的空数组引用。zustand selector 若每次返回新的 `[]`,useSyncExternalStore 会判定
 * 快照一直在变 → 无限重渲染("Maximum update depth exceeded")。所有"无变量"分支必须
 * 回退到这同一个引用,保证 selector 结果在变量真正变化前引用恒定。
 */
export const EMPTY_STORY_VARIABLES: StoryVariable[] = [];
export const EMPTY_STORY_FLAGS: StoryFlag[] = [];

export function storyVariablesOfNode(node: CanvasNode | undefined): StoryVariableDefinition[] {
  const data = node?.data as
    | {
        storyVariableDefinitions?: StoryVariableDefinition[];
      }
    | undefined;
  return data?.storyVariableDefinitions ?? EMPTY_STORY_VARIABLES;
}

export function storyFlagsOfNode(node: CanvasNode | undefined): StoryFlag[] {
  return (node?.data as { storyFlags?: StoryFlag[] } | undefined)?.storyFlags ?? EMPTY_STORY_FLAGS;
}

/** 取某故事组的变量(引用稳定:有变量时为该组实际数组,无变量时为共享空数组)。 */
export function selectGroupStoryVariables(nodes: CanvasNode[], groupId: string): StoryVariable[] {
  return storyVariablesOfNode(nodes.find((n) => n.id === groupId));
}

export function selectGroupStoryFlags(nodes: CanvasNode[], groupId: string): StoryFlag[] {
  return storyFlagsOfNode(nodes.find((n) => n.id === groupId));
}

/** 取某选项边 source 节点所属故事组的变量(引用稳定)。 */
export function selectStoryVariablesForEdgeSource(
  nodes: CanvasNode[],
  sourceId: string,
): StoryVariable[] {
  const src = nodes.find((n) => n.id === sourceId);
  const group = src?.parentId ? nodes.find((n) => n.id === src.parentId) : undefined;
  return storyVariablesOfNode(group);
}

export function selectStoryFlagsForEdgeSource(nodes: CanvasNode[], sourceId: string): StoryFlag[] {
  const src = nodes.find((n) => n.id === sourceId);
  const group = src?.parentId ? nodes.find((n) => n.id === src.parentId) : undefined;
  return storyFlagsOfNode(group);
}
