import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { StoryVariable } from './storyTypes';

/**
 * 稳定的空数组引用。zustand selector 若每次返回新的 `[]`,useSyncExternalStore 会判定
 * 快照一直在变 → 无限重渲染("Maximum update depth exceeded")。所有"无变量"分支必须
 * 回退到这同一个引用,保证 selector 结果在变量真正变化前引用恒定。
 */
export const EMPTY_STORY_VARIABLES: StoryVariable[] = [];

function groupVariablesOf(node: CanvasNode | undefined): StoryVariable[] {
  const vars = (node?.data as { storyVariables?: StoryVariable[] } | undefined)?.storyVariables;
  return vars ?? EMPTY_STORY_VARIABLES;
}

/** 取某故事组的变量(引用稳定:有变量时为该组实际数组,无变量时为共享空数组)。 */
export function selectGroupStoryVariables(nodes: CanvasNode[], groupId: string): StoryVariable[] {
  return groupVariablesOf(nodes.find((n) => n.id === groupId));
}

/** 取某选项边 source 节点所属故事组的变量(引用稳定)。 */
export function selectStoryVariablesForEdgeSource(
  nodes: CanvasNode[],
  sourceId: string,
): StoryVariable[] {
  const src = nodes.find((n) => n.id === sourceId);
  const group = src?.parentId ? nodes.find((n) => n.id === src.parentId) : undefined;
  return groupVariablesOf(group);
}
