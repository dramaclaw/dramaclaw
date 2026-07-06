import { describe, expect, it } from 'vitest';
import { computeStoryPathCoverage } from '@/features/canvas/story/storyPathCoverage';
import type { StoryTreeModel, StoryTreeRow } from '@/features/canvas/story/buildStoryTree';
import { emptyStoryStats, type StoryStats } from '@/features/canvas/story/storyStats';

/** 精简造行工具:只填覆盖度计算用得到的字段。 */
function row(nodeId: string, over: Partial<StoryTreeRow> = {}): StoryTreeRow {
  return {
    nodeId,
    label: nodeId,
    depth: 0,
    incomingChoiceText: null,
    hasCondition: false,
    isTimedSource: false,
    isEnding: false,
    repeated: false,
    issues: [],
    children: [],
    ...over,
  };
}

function model(root: StoryTreeRow | null, orphans: StoryTreeModel['orphans'] = []): StoryTreeModel {
  return { root, noStart: false, orphans, errorCount: 0, warningCount: 0 };
}

/** 结构:start → (a→end1) / (b→end2)。 */
function sampleModel(): StoryTreeModel {
  return model(
    row('start', {
      children: [
        row('a', { incomingChoiceText: '左', children: [row('end1', { isEnding: true, endingLabel: 'GE' })] }),
        row('b', { incomingChoiceText: '右', children: [row('end2', { isEnding: true, endingLabel: 'BE' })] }),
      ],
    }),
  );
}

describe('computeStoryPathCoverage', () => {
  it('空统计:全部未探索,分母正确', () => {
    const cov = computeStoryPathCoverage(sampleModel(), emptyStoryStats());
    expect(cov.summary).toEqual({
      totalRuns: 0,
      exploredNodes: 0,
      totalNodes: 5, // start,a,b,end1,end2
      reachedEndings: 0,
      totalEndings: 2, // end1,end2
    });
    expect(cov.visitedNodeIds.size).toBe(0);
  });

  it('走过一条路径:该路径节点标记已访问,结局达成计数', () => {
    const stats: StoryStats = {
      totalRuns: 1,
      points: {
        start: { options: { 0: { text: '左', count: 1 } } },
        a: { options: { 0: { text: '继续', count: 1 } } },
      },
      endings: { end1: { title: '好结局', label: 'GE', count: 1 } },
    };
    const cov = computeStoryPathCoverage(sampleModel(), stats);
    expect(cov.visitedNodeIds.has('start')).toBe(true);
    expect(cov.visitedNodeIds.has('a')).toBe(true);
    expect(cov.visitedNodeIds.has('end1')).toBe(true); // 结局也算已访问
    expect(cov.visitedNodeIds.has('b')).toBe(false);
    expect(cov.endingCounts).toEqual({ end1: 1 });
    expect(cov.summary.exploredNodes).toBe(3); // start,a,end1
    expect(cov.summary.reachedEndings).toBe(1);
  });

  it('DAG 汇合(repeated)节点只计一次,不重复展开', () => {
    const shared = row('shared', { isEnding: true, endingLabel: 'GE' });
    const m = model(
      row('start', {
        children: [
          row('a', { children: [shared] }),
          row('b', { children: [row('shared', { isEnding: true, repeated: true })] }),
        ],
      }),
    );
    const cov = computeStoryPathCoverage(m, emptyStoryStats());
    expect(cov.summary.totalNodes).toBe(4); // start,a,b,shared
    expect(cov.summary.totalEndings).toBe(1); // shared 只算一个结局
  });

  it('统计里出现但不在树中的节点(孤立/已删)不计入分母,但仍算 visited', () => {
    const stats: StoryStats = {
      totalRuns: 0,
      points: { ghost: { options: { 0: { text: 'x', count: 1 } } } },
      endings: {},
    };
    const cov = computeStoryPathCoverage(sampleModel(), stats);
    expect(cov.visitedNodeIds.has('ghost')).toBe(true);
    expect(cov.summary.totalNodes).toBe(5);
    expect(cov.summary.exploredNodes).toBe(0); // ghost 不在树里,不计探索率
  });

  it('无根(空故事组):全 0', () => {
    const cov = computeStoryPathCoverage(model(null), emptyStoryStats());
    expect(cov.summary).toEqual({
      totalRuns: 0,
      exploredNodes: 0,
      totalNodes: 0,
      reachedEndings: 0,
      totalEndings: 0,
    });
  });
});
