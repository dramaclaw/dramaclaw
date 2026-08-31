// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFn } from "@/lib/i18n-types";

/**
 * 剧集没有 LLM 标题时，后端回填 `第N集` 当兜底（sqlite_store.py / cognee/store.py
 * 都是这个形状，episode_fixer 也拿它当「还没起名」的哨兵）。这串进了库，英文界面下
 * 会原样漏出中文，所以渲染时按集号重新本地化 —— 只认与集号对得上的那一条，用户手写
 * 的「第3集：雨夜」之类不动。
 */
const AUTO_EPISODE_TITLE = /^第\s*(\d+)\s*集$/;

export function isAutoEpisodeTitle(title: string | null | undefined, num: number): boolean {
  const matched = AUTO_EPISODE_TITLE.exec(String(title ?? "").trim());
  return matched !== null && Number(matched[1]) === num;
}

export function episodeDisplayTitle(
  num: number,
  title: string | null | undefined,
  t: TFn,
): string {
  const raw = String(title ?? "").trim();
  if (!raw || isAutoEpisodeTitle(raw, num)) return t("episode.list.episodeNumber", { n: num });
  return raw;
}
