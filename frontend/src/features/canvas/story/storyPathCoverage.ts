import type { StoryTreeModel, StoryTreeRow } from './buildStoryTree';
import type { StoryStats } from './storyStats';

/**
 * 路径回顾覆盖度:把「试玩统计(storyStats)」叠到「剧情树(buildStoryTree)」上,
 * 算出「哪些节点走过、哪些结局达成、还有多少没看」——给玩家/创作者地图感(P1 #8)。
 *
 * 已访问 = 该节点作为选择点被选过(stats.points)或作为结局被达成过(stats.endings)。
 * 分母只数「从起点可达的树内节点」;统计里出现但已不在树中的幽灵节点(节点被删/孤立)
 * 仍算 visited 但不计入探索率分母,避免比率被脏数据污染。
 */

export interface StoryPathCoverage {
  /** 访问过的节点 id(选择点或结局都算)。 */
  visitedNodeIds: Set<string>;
  /** 结局 nodeId → 达成次数(未达成的不在表内)。 */
  endingCounts: Record<string, number>;
  summary: {
    totalRuns: number;
    /** 树内已探索节点数。 */
    exploredNodes: number;
    /** 树内节点总数(去重)。 */
    totalNodes: number;
    /** 已达成结局数。 */
    reachedEndings: number;
    /** 结局总数(去重)。 */
    totalEndings: number;
  };
}

export function computeStoryPathCoverage(
  model: StoryTreeModel,
  stats: StoryStats,
): StoryPathCoverage {
  const visitedNodeIds = new Set<string>([
    ...Object.keys(stats.points),
    ...Object.keys(stats.endings),
  ]);
  const endingCounts: Record<string, number> = {};
  for (const [nodeId, e] of Object.entries(stats.endings)) endingCounts[nodeId] = e.count;

  // 遍历树收集去重节点/结局。repeated 行是 DAG 汇合的占位副本(children 已空),
  // 其 nodeId 在首次展开时已计入,这里不再重复计。
  const allNodeIds = new Set<string>();
  const endingIds = new Set<string>();
  const walk = (row: StoryTreeRow): void => {
    allNodeIds.add(row.nodeId);
    if (row.isEnding) endingIds.add(row.nodeId);
    if (!row.repeated) row.children.forEach(walk);
  };
  if (model.root) walk(model.root);

  let exploredNodes = 0;
  for (const id of allNodeIds) if (visitedNodeIds.has(id)) exploredNodes++;
  let reachedEndings = 0;
  for (const id of endingIds) if (endingCounts[id] != null) reachedEndings++;

  return {
    visitedNodeIds,
    endingCounts,
    summary: {
      totalRuns: stats.totalRuns,
      exploredNodes,
      totalNodes: allNodeIds.size,
      reachedEndings,
      totalEndings: endingIds.size,
    },
  };
}
