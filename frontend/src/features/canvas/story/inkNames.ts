/**
 * 把任意节点 id 转成合法的 ink knot 名:只保留字母数字下划线,统一加 `clip_`
 * 前缀(保证字母开头,且不与 ink 关键字冲突)。同一 id 永远得到同一 knot 名,
 * 供编译与运行时双向查表。
 */
export function knotNameForNodeId(nodeId: string): string {
  const sanitized = nodeId.replace(/[^a-zA-Z0-9_]/g, '_');
  return `clip_${sanitized}`;
}
