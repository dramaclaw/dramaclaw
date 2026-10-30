function encodeIdentifier(value: string): string {
  // Encode underscores too, so literal escape-looking IDs cannot collide.
  return value.replace(/[^a-zA-Z0-9]/g, (char) => `_${char.charCodeAt(0).toString(16)}_`);
}

/**
 * 把任意节点 id 转成合法的 ink knot 名:对非字母数字字符逐个编码,统一加 `clip_`
 * 前缀(保证字母开头,且不与 ink 关键字冲突)。同一 id 永远得到同一 knot 名,
 * 供编译与运行时双向查表。
 */
export function knotNameForNodeId(nodeId: string): string {
  return `clip_${encodeIdentifier(nodeId)}`;
}

/** Numeric variables and flags use a namespace distinct from knots and reentry knots.
 * Authored names stay in the canvas; only Ink declarations and references are encoded.
 * Encoding underscores makes the mapping injective, including escape-looking names.
 * This namespace change predates the interactive story feature's first release.
 * Development saves from before this change may fail the story fingerprint check;
 * no legacy save migration is required for this change.
 */
export function stateNameForVariable(name: string): string {
  return `state_${encodeIdentifier(name)}`;
}
