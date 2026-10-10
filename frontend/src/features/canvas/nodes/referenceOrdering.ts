// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 把上游节点按用户在「引用资源」行里手动拖出来的顺序（`referenceOrder`）排序。
 * 在 `referenceOrder` 里出现的节点按其下标排前面；没出现的（新连进来的）按「连接
 * 顺序」接在已排序的后面，即后引用的图片始终排在先引用的之后——**不**按画布 y 位置，
 * 否则在上方新连入的图片会插到下方旧图前面（序号 1/2 错乱）。仅用户手动拖动才改顺序。
 * 入参 `nodes` 已是连接时序（`useUpstreamNodes` 按上游边的追加顺序返回），用它的下标
 * 作为「未手动排序」节点之间的回退次序。chip 显示、图片N/音频N 编号、提交顺序三处
 * 都走这个函数，保证可视顺序与提交顺序始终一致。
 */
/**
 * 按「连线顺序」（edges 数组里边的追加顺序）收集某节点的一跳上游节点。
 *
 * UI 编号（@图片N / 引用行 chip，走 useUpstreamNodes）与提交时收集 references
 * 必须用同一个函数：曾经提交侧按 `state.nodes.filter(...)`（节点创建顺序）收集，
 * 先创建但后连线的节点会被排到 references 前面，prompt 里的 @图片1 在后端就
 * 指向另一张图（后端按 references 里图片的位置解释 图片N）。执行依赖
 * (`dependency_for`) 只控制先后，不属于可消费的上游参考。
 */
type UpstreamEdge = {
  source: string;
  target: string;
  data?: unknown;
};

export function isExecutionDependencyEdge(edge: UpstreamEdge): boolean {
  const data = edge.data;
  return (
    typeof data === "object"
    && data !== null
    && !Array.isArray(data)
    && (data as { link_type?: unknown }).link_type === "dependency_for"
  );
}

export function upstreamNodesInEdgeOrder<T extends { id: string }>(
  nodes: T[],
  edges: ReadonlyArray<UpstreamEdge>,
  targetId: string,
): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return edges
    .filter((edge) => edge.target === targetId && !isExecutionDependencyEdge(edge))
    .map((edge) => byId.get(edge.source))
    .filter((node): node is T => node !== undefined);
}

/**
 * 图片节点提交给后端的参考图有序列表：节点自带参考图（用户直接上传到节点上的）
 * 排第 1，上游连线的图按序接在后面，URL 去重（自带图与某张上游图同 URL 时保留
 * 最前的位置）。后端按位置解释 图片N，所以 @图片N 编号、mention 重排基线、提交
 * 三处必须共用这一份列表 —— 否则自带参考图会占掉第 1 位，让所有 @图片N 偏移 1。
 */
export function orderedReferenceUrlsWithOwnFirst(
  ownReferenceUrl: string | null,
  upstreamUrls: string[],
): string[] {
  return Array.from(
    new Set(
      [ownReferenceUrl, ...upstreamUrls].filter(
        (url): url is string => typeof url === "string" && url.length > 0,
      ),
    ),
  );
}

export function sortUpstreamByReferenceOrder<T extends { id: string }>(
  nodes: T[],
  referenceOrder: string[] | undefined,
): T[] {
  const orderIndex = new Map<string, number>();
  (referenceOrder ?? []).forEach((nid, i) => orderIndex.set(nid, i));
  const inputIndex = new Map<string, number>();
  nodes.forEach((node, i) => inputIndex.set(node.id, i));
  return [...nodes].sort((a, b) => {
    const ia = orderIndex.has(a.id)
      ? (orderIndex.get(a.id) as number)
      : Number.POSITIVE_INFINITY;
    const ib = orderIndex.has(b.id)
      ? (orderIndex.get(b.id) as number)
      : Number.POSITIVE_INFINITY;
    if (ia !== ib) return ia - ib;
    return (inputIndex.get(a.id) ?? 0) - (inputIndex.get(b.id) ?? 0);
  });
}
