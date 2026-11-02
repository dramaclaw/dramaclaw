import type { ExplorationNode } from './storyExploration';

export const EXPLORATION_NODE_WIDTH = 216;
export const EXPLORATION_NODE_HEIGHT = 96;

/** A read-only, left-to-right layout. Each segment appears once, including merges and loops. */
export function layoutExplorationGraph(nodes: ExplorationNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  for (const root of nodes) {
    if (depths.has(root.id)) continue;
    depths.set(root.id, 0);
    const queue = [root.id];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      for (const next of byId.get(id)?.successors ?? []) {
        if (!byId.has(next) || depths.has(next)) continue;
        depths.set(next, depths.get(id)! + 1);
        queue.push(next);
      }
    }
  }
  const columns = new Map<number, ExplorationNode[]>();
  for (const node of nodes) {
    const depth = depths.get(node.id)!;
    columns.set(depth, [...(columns.get(depth) ?? []), node]);
  }
  const maxRows = Math.max(1, ...Array.from(columns.values(), (column) => column.length));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, column] of columns) {
    column.forEach((node, index) => positions.set(node.id, {
      x: 56 + depth * 400, y: 56 + (maxRows - column.length) * 80 + index * 160,
    }));
  }
  const edges = nodes.flatMap((node) => [...new Set(node.successors)].filter((id) => byId.has(id)).map((target) => {
    const sourcePoint = positions.get(node.id)!;
    const targetPoint = positions.get(target)!;
    const x1 = sourcePoint.x + EXPLORATION_NODE_WIDTH, y1 = sourcePoint.y + EXPLORATION_NODE_HEIGHT / 2;
    const x2 = targetPoint.x, y2 = targetPoint.y + EXPLORATION_NODE_HEIGHT / 2;
    let path: string;
    let labelY = (y1 + y2) / 2;
    if (x2 > x1) {
      const middle = (x1 + x2) / 2;
      path = `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`;
    } else {
      // Return links travel above both nodes instead of crossing through their labels.
      const top = Math.min(sourcePoint.y, targetPoint.y) - 28;
      labelY = top;
      path = `M ${x1} ${y1} C ${x1 + 44} ${y1}, ${x1 + 44} ${top}, ${x1} ${top}`
        + ` L ${x2} ${top} C ${x2 - 44} ${top}, ${x2 - 44} ${y2}, ${x2} ${y2}`;
    }
    const text = [...new Set(node.choices?.filter((choice) => choice.target === target).map((choice) => choice.text) ?? [])].join(' / ');
    return { id: JSON.stringify([node.id, target]), source: node.id, target, path,
      text, labelX: (x1 + x2) / 2, labelY };
  }));
  return {
    positions, edges,
    width: 112 + Math.max(0, ...depths.values()) * 400 + EXPLORATION_NODE_WIDTH,
    height: 112 + (maxRows - 1) * 160 + EXPLORATION_NODE_HEIGHT,
  };
}
