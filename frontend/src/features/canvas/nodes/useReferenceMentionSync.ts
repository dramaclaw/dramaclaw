// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef } from "react";

import {
  remapReferenceMentions,
  sameOrder,
  type MentionFamily,
} from "./referenceMentions";

export interface ReferenceMentionFamilyInput {
  /** mention 前缀，如 "图片"（视频 / ImageGen）/ "图"（ImageEdit）/ "音频"。 */
  prefix: string;
  /** 缺省 `at`；MiniMax H3 的全局占位符使用 `mixed`。 */
  syntax?: "at" | "mixed";
  /**
   * 当前帧的有序引用 id 列表，下标 +1 即该引用在 prompt 里的序号（@<前缀>N）。
   * 必须与节点给「角色库 / 引用行」编号时用的有序列表一致（去重后、连接顺序）。
   */
  ids: string[];
}

// 拼 signature 用的分隔符，取节点 id / 前缀里不会出现的不可见字符，避免拼接歧义。
const FIELD_SEP = "␟";
const FAMILY_SEP = "␞";

/**
 * 让 prompt 里的 `@<前缀>N` mention 始终跟随引用编号：每当某个 family 的有序 id 列表
 * 变化（删除 / 重排 / 新增引用连线，覆盖所有删边路径），就把 prompt 里对应的数字重写，
 * 被删引用的 mention 连同其后随空格一起移除。首帧只记录基线、不改 prompt —— 持久化的
 * mention 已与当时的引用顺序一致。详见 referenceMentions.ts。
 *
 * `applyPrompt` 应稳定（useCallback）；即便不稳定也仅多跑一次空操作（sameOrder 守卫
 * 保证只有顺序真的变了才写回），不会损坏 prompt。
 */
export function useReferenceMentionSync(
  prompt: string,
  families: ReferenceMentionFamilyInput[],
  applyPrompt: (next: string) => void,
): void {
  const prevRef = useRef<Map<string, string[]> | null>(null);
  // 结构签名作为 effect 依赖：只有某个 family 的 ids 真的变化时才重新运行。
  const signature = families
    .map(
      (family) =>
        family.prefix +
        FIELD_SEP +
        (family.syntax ?? "at") +
        FIELD_SEP +
        family.ids.join(FIELD_SEP),
    )
    .join(FAMILY_SEP);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = new Map(
      families.map((family) => [family.prefix, family.ids] as const),
    );
    // 首帧只记录基线，不动 prompt。
    if (!prev) return;

    let changed = false;
    const remapFamilies: MentionFamily[] = families.map((family) => {
      const prevIds = prev.get(family.prefix) ?? [];
      if (!sameOrder(prevIds, family.ids)) changed = true;
      return {
        prefix: family.prefix,
        syntax: family.syntax,
        prevIds,
        nextIds: family.ids,
      };
    });
    if (!changed) return;

    const next = remapReferenceMentions(prompt, remapFamilies);
    if (next !== prompt) applyPrompt(next);
    // families 由 signature 表征；prompt / applyPrompt 显式列出。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, prompt, applyPrompt]);
}
