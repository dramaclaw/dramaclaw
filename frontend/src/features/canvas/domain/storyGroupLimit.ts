import { CANVAS_NODE_TYPES } from './canvasNodes';

type StoryGroupCandidate = { type?: string; data?: unknown };

export function isStoryGroup(node: StoryGroupCandidate): boolean {
  return node.type === CANVAS_NODE_TYPES.group && (node.data as { storyGroup?: unknown } | undefined)?.storyGroup === true;
}

export function canAddStoryGroups(
  existing: readonly StoryGroupCandidate[],
  incoming: readonly StoryGroupCandidate[],
): boolean {
  const added = incoming.filter(isStoryGroup).length;
  return added === 0 || existing.filter(isStoryGroup).length + added <= 1;
}
