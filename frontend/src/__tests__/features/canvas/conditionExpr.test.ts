import { describe, expect, it } from 'vitest';
import { isConditionGroup, isVisitCondition, conditionLeaves } from '@/features/canvas/story/conditionExpr';
import type { StoryChoiceCondition, StoryConditionGroup } from '@/features/canvas/story/storyTypes';

const leaf: StoryChoiceCondition = { var: 'fav', op: '>=', value: 5 };
const group: StoryConditionGroup = {
  join: 'and',
  items: [
    { var: 'fav', op: '>=', value: 5 },
    { var: 'trust', op: '>=', value: 0 },
  ],
};

describe('conditionExpr', () => {
  it('isConditionGroup 用 join 判别组与叶子', () => {
    expect(isConditionGroup(group)).toBe(true);
    expect(isConditionGroup(leaf)).toBe(false);
  });

  it('conditionLeaves:叶子返回单元素', () => {
    expect(conditionLeaves(leaf)).toEqual([leaf]);
  });

  it('conditionLeaves:组返回 items', () => {
    expect(conditionLeaves(group)).toEqual(group.items);
  });

  it('conditionLeaves:undefined 返回空数组', () => {
    expect(conditionLeaves(undefined)).toEqual([]);
  });

  it('isVisitCondition 用 visitedNodeId 判别访问叶子', () => {
    expect(isVisitCondition({ visitedNodeId: 'n1', op: '>=', value: 1 })).toBe(true);
    expect(isVisitCondition({ var: 'fav', op: '>=', value: 5 })).toBe(false);
  });

  it('conditionLeaves 摊平含访问叶子的组', () => {
    const g = { join: 'and' as const, items: [
      { var: 'fav', op: '>=' as const, value: 5 },
      { visitedNodeId: 'n1', op: '>=' as const, value: 1 },
    ] };
    expect(conditionLeaves(g)).toEqual(g.items);
  });
});
