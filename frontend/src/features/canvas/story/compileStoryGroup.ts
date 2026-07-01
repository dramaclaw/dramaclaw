import {
  isVideoNode,
  type CanvasEdge,
  type CanvasNode,
  type GroupNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type CompiledStory, type StoryVariable } from './storyTypes';
import { compileGraphToInk } from './compileGraphToInk';

/** 取某故事组的成员片段 + 成员间选项边 + 该组变量,编译成可运行 ink。 */
export function compileStoryGroup(
  groupId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CompiledStory {
  const groupNode = nodes.find((n) => n.id === groupId);
  const variables: StoryVariable[] =
    (groupNode?.data as GroupNodeData | undefined)?.storyVariables ?? [];

  const members = nodes.filter((n) => n.parentId === groupId && isVideoNode(n));
  const memberIds = new Set(members.map((n) => n.id));
  const memberEdges = edges.filter(
    (e) => e.type === STORY_CHOICE_EDGE_TYPE && memberIds.has(e.source) && memberIds.has(e.target),
  );

  return compileGraphToInk(members, memberEdges, variables);
}
