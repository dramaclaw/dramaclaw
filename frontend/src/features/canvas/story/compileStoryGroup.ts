import i18next from 'i18next';
import {
  isVideoNode,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type CompiledStory, type StoryFlag, type StoryVariable } from './storyTypes';
import { compileGraphToInk, StoryCompileError } from './compileGraphToInk';
import { storyFlagsOfNode, storyVariablesOfNode } from './storyVariableSelectors';
import { lintStory } from './lintStory';

/** 取某故事组的成员片段 + 成员间选项边 + 该组变量,编译成可运行 ink。 */
export function compileStoryGroup(
  groupId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  options: { entryNodeId?: string } = {},
): CompiledStory {
  const groupNode = nodes.find((n) => n.id === groupId);
  const variables: StoryVariable[] = storyVariablesOfNode(groupNode);
  const flags: StoryFlag[] = storyFlagsOfNode(groupNode);

  const members = nodes.filter((n) => n.parentId === groupId && isVideoNode(n));
  const memberIds = new Set(members.map((n) => n.id));
  const scopedEdges = edges.filter(
    (e) => e.type === STORY_CHOICE_EDGE_TYPE && memberIds.has(e.source),
  );
  // An explicit entry is the editor's isolated clip debugger; normal play and export have no entry override.
  const errors = lintStory(members, scopedEdges, variables, flags).filter((issue) =>
    issue.severity === 'error' && !(options.entryNodeId && issue.code === 'unreachable'),
  );
  if (errors.length > 0) {
    throw new StoryCompileError(
      'invalid_story',
      i18next.t('canvas.story.messages.validationErrors', { total: errors.length }),
    );
  }
  const memberEdges = scopedEdges.filter((edge) => memberIds.has(edge.target));

  return compileGraphToInk(members, memberEdges, variables, flags, options);
}
