// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 让提示词里的 `@图片N` / `@音频N` 引用始终与「角色库」里的连线引用一一对应。
 *
 * 背景：视频节点的 prompt 把 mention 序列化为纯文本 `@图片2`（数字是按插入当时的引用
 * 序号写死的，丢失了它指向哪个上游节点）。当用户删除 / 重排 / 新增引用连线时，角色库
 * 会重新编号（删掉图片1 后，原图片2 变成图片1），但 prompt 里的 `@图片2` 不会跟着变，
 * 于是 mention 失配（指向已不存在或错位的图片）。
 *
 * 这里用「上一帧的有序节点 id 列表」对「这一帧的有序节点 id 列表」做差分：每个
 * `@<前缀>N` 通过 `prevIds[N-1]` 还原出它当初指向的节点，再在 `nextIds` 里查它的新序号，
 * 据此重写数字；若该节点已被移除（连线删了），则连同 mention 一起删掉（含其后随的一个
 * 空格）。一次扫描原串完成，序号映射互不影响，不会出现 2→1、3→2 之间的串号。
 */
export interface MentionFamily {
  /** mention 前缀，如 "图片" / "音频"。 */
  prefix: string;
  /** `at` 对应 @图片N；`mixed` 对应 MiniMax H3 的 {{Mixed N}}。 */
  syntax?: "at" | "mixed";
  /** 变更前的有序上游节点 id（与变更前的序号 1..n 对应）。 */
  prevIds: string[];
  /** 变更后的有序上游节点 id（决定新的序号）。 */
  nextIds: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function remapReferenceMentions(
  prompt: string,
  families: MentionFamily[],
): string {
  let out = prompt;
  for (const { prefix, syntax = "at", prevIds, nextIds } of families) {
    // 同一帧内 prev/next 没变化就跳过，避免无谓的字符串重建。
    if (sameOrder(prevIds, nextIds)) {
      continue;
    }
    const pattern =
      syntax === "mixed"
        ? new RegExp(`\\{\\{${escapeRegExp(prefix)}\\s+(\\d+)\\}\\}(\\s?)`, "gi")
        : new RegExp(`@${escapeRegExp(prefix)}(\\d+)(\\s?)`, "g");
    out = out.replace(pattern, (full, numStr: string, trailing: string) => {
      const oldIndex = Number(numStr);
      const node = prevIds[oldIndex - 1];
      if (node === undefined) {
        // 越界 / 非受跟踪的 mention：原样保留。
        return full;
      }
      const nextIndex = nextIds.indexOf(node);
      if (nextIndex === -1) {
        // 该引用的连线被删了 → 连 mention 带后随空格一起去掉。
        return "";
      }
      return syntax === "mixed"
        ? `{{${prefix} ${nextIndex + 1}}}${trailing}`
        : `@${prefix}${nextIndex + 1}${trailing}`;
    });
  }
  return out;
}

export function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
