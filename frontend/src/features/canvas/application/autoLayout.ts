// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { DEFAULT_NODE_WIDTH, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

const DEFAULT_NODE_HEIGHT = 200;
const COLUMN_GAP = 80;
const ROW_GAP = 48;
// 同一行内两个连通分量之间的水平间距，比纵向间距略大以便视觉分隔。
const COMPONENT_GAP_X = 120;
// 不同行之间的纵向间距。
const COMPONENT_GAP_Y = 96;
// 重心法分配纵坐标后，允许保留的最大「全宽空白带」高度。超过它的空白带会被压缩到
// 这个值——空白带指某段 Y 区间内组件里没有任何节点覆盖，压缩纯粹是把带下方所有节点
// 统一上移，相对几何与连线走向不变，只删掉视觉上的大片空隙。
const MAX_VERTICAL_GAP = 120;
// 整理后画布的目标宽高比（屏幕通常 16:9 略宽于 1，这里取 1.6:1）。
// 用来根据总面积估算 shelf 打包的条带宽度，避免所有连通分量被堆成一条
// 几千像素长的纵向带子（旧版行为）。
const TARGET_PAGE_ASPECT = 16 / 9;

interface NodeSize {
  width: number;
  height: number;
}

function getNodeSize(node: CanvasNode): NodeSize {
  const width = node.measured?.width
    ?? (typeof node.width === 'number' ? node.width : DEFAULT_NODE_WIDTH);
  const height = node.measured?.height
    ?? (typeof node.height === 'number' ? node.height : DEFAULT_NODE_HEIGHT);
  return { width, height };
}

function computeComponents(
  nodes: CanvasNode[],
  edgePairs: Array<[string, string]>
): CanvasNode[][] {
  const idMap = new Map(nodes.map((node) => [node.id, node] as const));
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const [source, target] of edgePairs) {
    adjacency.get(source)?.add(target);
    adjacency.get(target)?.add(source);
  }

  const visited = new Set<string>();
  const components: CanvasNode[][] = [];
  for (const node of nodes) {
    if (visited.has(node.id)) {
      continue;
    }
    const stack = [node.id];
    const component: CanvasNode[] = [];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      const current = idMap.get(id);
      if (!current) {
        continue;
      }
      component.push(current);
      const neighbors = adjacency.get(id);
      if (!neighbors) {
        continue;
      }
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          stack.push(neighborId);
        }
      }
    }
    if (component.length > 0) {
      components.push(component);
    }
  }
  return components;
}

function computeLevels(
  nodeIds: string[],
  outgoing: Map<string, string[]>,
  incoming: Map<string, string[]>
): Map<string, number> {
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const id of nodeIds) {
    if ((incoming.get(id) ?? []).length === 0) {
      level.set(id, 0);
      queue.push(id);
    }
  }
  // 最长路径分层；用节点总数做层级上限，避免「环 + 上游入口」时 candidate 无限增长
  // 导致死循环（用户手动连线没有任何环检测，整理时会卡死整页）。简单路径层级不超过
  // N-1，所以 DAG 永远碰不到这个上限、行为不变；环里的节点则在上限处停止传播。
  const maxLevel = nodeIds.length;
  while (queue.length > 0) {
    const id = queue.shift()!;
    const currentLevel = level.get(id) ?? 0;
    for (const target of outgoing.get(id) ?? []) {
      const candidate = currentLevel + 1;
      if (candidate > maxLevel) {
        continue;
      }
      const existing = level.get(target);
      if (existing === undefined || candidate > existing) {
        level.set(target, candidate);
        queue.push(target);
      }
    }
  }
  for (const id of nodeIds) {
    if (!level.has(id)) {
      level.set(id, 0);
    }
  }
  return level;
}

interface LayoutComponentResult {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

// 排序/坐标的迭代次数：经验上 4~8 趟即可收敛，过多收益递减。
const ORDER_SWEEPS = 6;
const COORD_SWEEPS = 8;

function median(sortedValues: number[]): number {
  const n = sortedValues.length;
  if (n === 0) {
    return 0;
  }
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? sortedValues[mid]
    : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

/**
 * 在固定的层内顺序下，把各节点中心尽量贴近 `desired`，同时保证相邻节点不重叠
 * （间距 = 两者半高之和 + ROW_GAP）。先按顺序做一次向下挤压消重叠，再整体
 * 平移使该列中心的均值对齐 desired 的均值，避免多趟迭代后整列单向漂移。
 */
function resolveColumnCenters(
  orderedIds: string[],
  desired: Map<string, number>,
  heights: Map<string, number>,
  centerY: Map<string, number>
): void {
  const n = orderedIds.length;
  if (n === 0) {
    return;
  }
  const centers = orderedIds.map((id) => desired.get(id) ?? centerY.get(id) ?? 0);
  for (let i = 1; i < n; i += 1) {
    const prevHalf = (heights.get(orderedIds[i - 1]) ?? DEFAULT_NODE_HEIGHT) / 2;
    const currHalf = (heights.get(orderedIds[i]) ?? DEFAULT_NODE_HEIGHT) / 2;
    const minCenter = centers[i - 1] + prevHalf + ROW_GAP + currHalf;
    if (centers[i] < minCenter) {
      centers[i] = minCenter;
    }
  }
  const desiredMean = mean(orderedIds.map((id) => desired.get(id) ?? centerY.get(id) ?? 0));
  const shift = desiredMean - mean(centers);
  for (let i = 0; i < n; i += 1) {
    centerY.set(orderedIds[i], centers[i] + shift);
  }
}

/**
 * 压缩组件内的「全宽纵向空白带」。重心法可能把稀疏区域拉得很开，导致某段 Y 区间里
 * 所有列都没有节点——一条横贯的空白带。这里按节点纵向区间的并集找出这些空白带，把
 * 超过 MAX_VERTICAL_GAP 的部分整体压掉：对空白带下方的所有节点做统一上移，因此保留了
 * 相对顺序、不产生重叠、连线走向也不变，只是删掉空隙。就地修改 centerY。
 */
function compactVerticalBands(
  ids: string[],
  heights: Map<string, number>,
  centerY: Map<string, number>
): void {
  const intervals = ids
    .map((id) => {
      const half = (heights.get(id) ?? DEFAULT_NODE_HEIGHT) / 2;
      const c = centerY.get(id) ?? 0;
      return { id, top: c - half, bottom: c + half };
    })
    .sort((a, b) => a.top - b.top);
  let maxBottom = Number.NEGATIVE_INFINITY;
  let cumulativeShift = 0;
  for (const interval of intervals) {
    if (maxBottom !== Number.NEGATIVE_INFINITY && interval.top - maxBottom > MAX_VERTICAL_GAP) {
      cumulativeShift += interval.top - maxBottom - MAX_VERTICAL_GAP;
    }
    if (cumulativeShift > 0) {
      centerY.set(interval.id, (centerY.get(interval.id) ?? 0) - cumulativeShift);
    }
    maxBottom = Math.max(maxBottom, interval.bottom);
  }
}

function layoutComponent(
  componentNodes: CanvasNode[],
  edgePairs: Array<[string, string]>
): LayoutComponentResult {
  const ids = componentNodes.map((node) => node.id);
  const idSet = new Set(ids);
  const nodeById = new Map(componentNodes.map((node) => [node.id, node] as const));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of ids) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const [source, target] of edgePairs) {
    if (!idSet.has(source) || !idSet.has(target) || source === target) {
      continue;
    }
    outgoing.get(source)!.push(target);
    incoming.get(target)!.push(source);
  }

  const level = computeLevels(ids, outgoing, incoming);
  // 每层节点 id 列表；初始顺序按原始位置（上→下、左→右），为后续迭代提供稳定起点。
  const columns = new Map<number, string[]>();
  for (const node of componentNodes) {
    const lvl = level.get(node.id) ?? 0;
    const bucket = columns.get(lvl) ?? [];
    bucket.push(node.id);
    columns.set(lvl, bucket);
  }
  const sortedLevels = [...columns.keys()].sort((a, b) => a - b);
  for (const lvl of sortedLevels) {
    columns.get(lvl)!.sort((a, b) => {
      const na = nodeById.get(a)!;
      const nb = nodeById.get(b)!;
      if (na.position.y !== nb.position.y) {
        return na.position.y - nb.position.y;
      }
      return na.position.x - nb.position.x;
    });
  }

  const indexInLayer = (lvl: number): Map<string, number> => {
    const map = new Map<string, number>();
    (columns.get(lvl) ?? []).forEach((id, index) => map.set(id, index));
    return map;
  };

  // —— 阶段 1：中位数启发式排序，减少相邻层之间的连线交叉 ——
  // 每趟把某层按「邻接层中相连节点的位置中位数」重排；上下交替扫描多趟收敛。
  for (let sweep = 0; sweep < ORDER_SWEEPS; sweep += 1) {
    const downward = sweep % 2 === 0;
    const order = downward ? sortedLevels.slice(1) : [...sortedLevels].reverse().slice(1);
    for (const lvl of order) {
      const adjLevel = downward ? lvl - 1 : lvl + 1;
      const adjIndex = indexInLayer(adjLevel);
      const neighborMap = downward ? incoming : outgoing;
      const arr = columns.get(lvl)!;
      const currentIndex = new Map(arr.map((id, index) => [id, index] as const));
      const keyed = arr.map((id) => {
        const neighborIndices = (neighborMap.get(id) ?? [])
          .map((neighbor) => adjIndex.get(neighbor))
          .filter((value): value is number => value !== undefined)
          .sort((a, b) => a - b);
        // 无相连邻居的节点保持原相对位置，避免被随意打散。
        const key = neighborIndices.length > 0 ? median(neighborIndices) : currentIndex.get(id)!;
        return { id, key, fallback: currentIndex.get(id)! };
      });
      keyed.sort((a, b) => (a.key !== b.key ? a.key - b.key : a.fallback - b.fallback));
      columns.set(lvl, keyed.map((entry) => entry.id));
    }
  }

  // —— 列宽 / 列 X 坐标（左→右按顺序、同层等宽居中）——
  const columnWidths = new Map<number, number>();
  for (const lvl of sortedLevels) {
    let maxWidth = 0;
    for (const id of columns.get(lvl)!) {
      maxWidth = Math.max(maxWidth, getNodeSize(nodeById.get(id)!).width);
    }
    columnWidths.set(lvl, maxWidth);
  }
  const columnX = new Map<number, number>();
  let xCursor = 0;
  for (const lvl of sortedLevels) {
    columnX.set(lvl, xCursor);
    xCursor += (columnWidths.get(lvl) ?? 0) + COLUMN_GAP;
  }

  // —— 阶段 2：纵向坐标分配（重心法）——
  // 先按顺序堆叠得到初始中心；再多趟把每个节点拉向相邻层中相连节点的平均高度，
  // 让有连线的节点纵向对齐，长斜线/交叉显著减少。
  const heights = new Map<string, number>();
  for (const id of ids) {
    heights.set(id, getNodeSize(nodeById.get(id)!).height);
  }
  const centerY = new Map<string, number>();
  for (const lvl of sortedLevels) {
    let yCursor = 0;
    for (const id of columns.get(lvl)!) {
      const half = (heights.get(id) ?? DEFAULT_NODE_HEIGHT) / 2;
      centerY.set(id, yCursor + half);
      yCursor += (heights.get(id) ?? DEFAULT_NODE_HEIGHT) + ROW_GAP;
    }
  }
  for (let sweep = 0; sweep < COORD_SWEEPS; sweep += 1) {
    const downward = sweep % 2 === 0;
    const order = downward ? sortedLevels : [...sortedLevels].reverse();
    for (const lvl of order) {
      const adjLevel = downward ? lvl - 1 : lvl + 1;
      const neighborMap = downward ? incoming : outgoing;
      const arr = columns.get(lvl)!;
      const desired = new Map<string, number>();
      for (const id of arr) {
        const neighborCenters = (neighborMap.get(id) ?? [])
          .filter((neighbor) => level.get(neighbor) === adjLevel)
          .map((neighbor) => centerY.get(neighbor)!)
          .filter((value) => value !== undefined);
        if (neighborCenters.length > 0) {
          desired.set(id, mean(neighborCenters));
        }
      }
      resolveColumnCenters(arr, desired, heights, centerY);
    }
  }

  // —— 阶段 3：压缩全宽纵向空白带，去掉重心法留下的大片中间空白 ——
  compactVerticalBands(ids, heights, centerY);

  // —— 收尾：把中心坐标换算成左上角坐标，并归一化到组件局部 (0,0) ——
  const positions = new Map<string, { x: number; y: number }>();
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const lvl of sortedLevels) {
    const colX = columnX.get(lvl) ?? 0;
    const colWidth = columnWidths.get(lvl) ?? 0;
    for (const id of columns.get(lvl)!) {
      const size = getNodeSize(nodeById.get(id)!);
      const x = colX + (colWidth - size.width) / 2;
      const y = (centerY.get(id) ?? 0) - size.height / 2;
      positions.set(id, { x, y });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + size.width);
      maxY = Math.max(maxY, y + size.height);
    }
  }

  if (!Number.isFinite(minX)) {
    return { positions, width: 0, height: 0 };
  }
  for (const [id, pos] of positions) {
    positions.set(id, { x: pos.x - minX, y: pos.y - minY });
  }
  return { positions, width: maxX - minX, height: maxY - minY };
}

export interface AutoLayoutResult {
  positions: Record<string, { x: number; y: number }>;
  changedCount: number;
}

export function computeAutoLayout(
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): AutoLayoutResult {
  const topLevelNodes = nodes.filter((node) => !node.parentId);
  if (topLevelNodes.length === 0) {
    return { positions: {}, changedCount: 0 };
  }

  const topLevelIds = new Set(topLevelNodes.map((node) => node.id));
  const edgePairs: Array<[string, string]> = [];
  for (const edge of edges) {
    if (topLevelIds.has(edge.source) && topLevelIds.has(edge.target)) {
      edgePairs.push([edge.source, edge.target]);
    }
  }

  const anchorX = topLevelNodes.reduce(
    (acc, node) => Math.min(acc, node.position.x),
    Number.POSITIVE_INFINITY
  );
  const anchorY = topLevelNodes.reduce(
    (acc, node) => Math.min(acc, node.position.y),
    Number.POSITIVE_INFINITY
  );
  const baseX = Number.isFinite(anchorX) ? anchorX : 0;
  const baseY = Number.isFinite(anchorY) ? anchorY : 0;

  const components = computeComponents(topLevelNodes, edgePairs);
  // 排序仍按"原始位置左上 → 右下"，让整理后的相对顺序贴近用户的心智位置，
  // 便于在重排后凭印象快速定位某个节点。
  components.sort((a, b) => {
    const aMin = Math.min(...a.map((node) => node.position.y));
    const bMin = Math.min(...b.map((node) => node.position.y));
    if (aMin !== bMin) {
      return aMin - bMin;
    }
    const aX = Math.min(...a.map((node) => node.position.x));
    const bX = Math.min(...b.map((node) => node.position.x));
    return aX - bX;
  });

  // 先对每个连通分量内部做布局，拿到各自的 bbox。
  const laidOut = components.map((component) => ({
    component,
    layout: layoutComponent(component, edgePairs),
  }));

  // 估算 shelf 打包的目标条带宽度：按总面积 + 期望宽高比反推，并保证至少
  // 能容纳最宽的单个分量。这样既能让一行塞下若干小分量，也避免大分量被
  // 强行换行截断。
  const totalArea = laidOut.reduce(
    (acc, item) => acc + item.layout.width * item.layout.height,
    0,
  );
  const widestComponent = laidOut.reduce(
    (acc, item) => Math.max(acc, item.layout.width),
    0,
  );
  const idealStripWidth = totalArea > 0
    ? Math.sqrt(totalArea * TARGET_PAGE_ASPECT)
    : 0;
  const stripWidth = Math.max(idealStripWidth, widestComponent);

  // Shelf 打包：从左到右往当前行塞，超出 stripWidth 就换下一行。
  // 行高 = 当行内分量的最大高度，下一行用 baseY + rowYCursor 起算。
  const positions: Record<string, { x: number; y: number }> = {};
  let rowXCursor = 0;
  let rowYCursor = 0;
  let currentRowMaxHeight = 0;
  for (const { layout } of laidOut) {
    if (rowXCursor > 0 && rowXCursor + layout.width > stripWidth) {
      rowYCursor += currentRowMaxHeight + COMPONENT_GAP_Y;
      rowXCursor = 0;
      currentRowMaxHeight = 0;
    }
    for (const [id, pos] of layout.positions) {
      positions[id] = {
        x: baseX + rowXCursor + pos.x,
        y: baseY + rowYCursor + pos.y,
      };
    }
    rowXCursor += layout.width + COMPONENT_GAP_X;
    currentRowMaxHeight = Math.max(currentRowMaxHeight, layout.height);
  }

  let changedCount = 0;
  const nodeMap = new Map(topLevelNodes.map((node) => [node.id, node] as const));
  for (const [id, pos] of Object.entries(positions)) {
    const node = nodeMap.get(id);
    if (!node) {
      continue;
    }
    if (Math.round(node.position.x) !== Math.round(pos.x)
      || Math.round(node.position.y) !== Math.round(pos.y)) {
      changedCount += 1;
    }
  }

  return { positions, changedCount };
}
