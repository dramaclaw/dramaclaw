import type {
  StoryConditionExpr,
  StoryConditionGroup,
  StoryConditionLeaf,
  StoryFlagCondition,
  StoryVisitCondition,
} from './storyTypes';

/** 判别:有 `join` 即复合组,否则单叶子。 */
export function isConditionGroup(c: StoryConditionExpr): c is StoryConditionGroup {
  return 'join' in c;
}

/** 判别:有 `visitedNodeId` 即访问计数叶子,否则变量比较叶子。 */
export function isVisitCondition(c: StoryConditionLeaf): c is StoryVisitCondition {
  return 'visitedNodeId' in c;
}

/** 判别:有 `flag` 即布尔状态条件。 */
export function isFlagCondition(c: StoryConditionLeaf): c is StoryFlagCondition {
  return 'flag' in c;
}

/** 摊平所有叶子条件:叶子→[c];组→items;空→[]。 */
export function conditionLeaves(c?: StoryConditionExpr): StoryConditionLeaf[] {
  if (!c) return [];
  return isConditionGroup(c) ? c.items : [c];
}
