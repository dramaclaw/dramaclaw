// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { AssetBoardColumn, AssetBoardData } from "@/features/canvas/domain/assetBoard";
import { KEY_ELEMENT_CATEGORY_KEYS, type KeyElementCategory } from "@/features/canvas/domain/keyElements";

/** 每页渲染多少个候选（滚动到底/键盘越界时再加载一页）。 */
export const FREEZONE_NODE_SUGGESTION_PAGE = 24;

export type FreezoneNodeSuggestion = {
  nodeId: string;
  column: AssetBoardColumn;
  title: string;
  thumbnailUrl: string | null;
  /** 片源地址（视频/音频/图片本体）。给「没记封面的视频」取首帧兜底用。 */
  mediaUrl: string | null;
  /** 关键元素分类（用户标记）；未标记为 null。默认排序据此把关键元素置顶。 */
  keyElementCategory: KeyElementCategory | null;
};

/**
 * 匹配光标处正在输入的 `@查询词`：`@` 需在串首或空白之后，token 内不含空白/@。
 * 与 `/技能` 的 getFreezoneSkillSlashQuery 同构——要求前置边界可避免邮箱 a@b 误触。
 * 返回 null 表示当前不在输入 @（菜单应关闭）。
 */
export function getFreezoneNodeAtQuery(value: string): string | null {
  const match = value.match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? match[1].trim().toLowerCase() : null;
}

/** 未标记关键元素的排序档位（排在四个分类之后）。 */
const NON_KEY_ELEMENT_RANK = KEY_ELEMENT_CATEGORY_KEYS.length;

function keyElementRank(category: KeyElementCategory | null): number {
  return category === null ? NON_KEY_ELEMENT_RANK : KEY_ELEMENT_CATEGORY_KEYS.indexOf(category);
}

/**
 * 把故事板四栏拍平成候选列表。默认排序：被标记为关键元素的节点按分类顺序
 * （人物→场景→物品→其他，对齐 KeyElementsBar）置顶，其余节点保持栏目顺序
 * （文本→图片→视频→音频）。同档内保持稳定顺序。
 */
export function buildFreezoneNodeSuggestions(board: AssetBoardData): FreezoneNodeSuggestion[] {
  const flattened = [...board.text, ...board.image, ...board.video, ...board.audio].map((item) => ({
    nodeId: item.nodeId,
    column: item.column,
    title: item.title,
    thumbnailUrl: item.thumbnailUrl,
    mediaUrl: item.mediaUrl,
    keyElementCategory: item.keyElementCategory,
  }));
  return flattened
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rankDelta =
        keyElementRank(a.item.keyElementCategory) - keyElementRank(b.item.keyElementCategory);
      return rankDelta !== 0 ? rankDelta : a.index - b.index;
    })
    .map((entry) => entry.item);
}

/** 按标题做大小写不敏感子串过滤；空查询返回全部。 */
export function filterFreezoneNodeSuggestions(
  items: FreezoneNodeSuggestion[],
  query: string,
): FreezoneNodeSuggestion[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) => item.title.toLowerCase().includes(normalized));
}

/** 抹掉光标处正在输入的 `@查询词` token，保留其余正文与前置空白。 */
export function stripFreezoneNodeAtQuery(value: string): string {
  const match = value.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!match || match.index === undefined) return value;
  const matched = match[0];
  const tokenStart = match.index + (matched.startsWith("@") ? 0 : 1);
  return value.slice(0, tokenStart);
}

/** 节点 token 语法 `@[节点名](nodeId)`。节点名不含 `]`/换行，nodeId 不含 `)`/空白。前置边界与 @ 检测一致。 */
const NODE_MENTION_PATTERN = /(?:^|\s)@\[([^\]\n]+)\]\(([^)\s]+)\)/gu;

export type FreezoneNodeMention = {
  nodeId: string;
  label: string;
  /** token 在字符串中的起点（指向 `@`）。 */
  start: number;
  /** token 结束位置（右括号之后）。 */
  end: number;
};

/**
 * 供编辑器 chip / 悬浮预览展示的节点查表：nodeId → 缩略图/片源/列。label 以 token 自带为准。
 * mediaUrl 是给「没记封面的视频」取首帧兜底用的（与故事板 VideoThumb 同口径）。
 */
export type FreezoneNodeMentionLookup = Map<
  string,
  { thumbnailUrl: string | null; mediaUrl: string | null; column: AssetBoardColumn }
>;

/** 节点名进 token 前清洗：去掉会破坏 `@[名](id)` 语法的字符，折叠空白。 */
export function sanitizeFreezoneNodeLabel(title: string): string {
  return title.replace(/[[\]()\n\r]/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * 把光标处正在输入的 `@查询词` 替换为节点 token `@[名](nodeId) `（尾部空格便于续输）。
 * 若当前没有 `@查询词`，则在末尾追加。对齐 insertFreezoneSkillMention。
 */
export function insertFreezoneNodeMention(value: string, nodeId: string, title: string): string {
  const label = sanitizeFreezoneNodeLabel(title) || nodeId;
  const token = `@[${label}](${nodeId}) `;
  const atMatch = value.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!atMatch || atMatch.index === undefined) {
    return `${value}${value && !/\s$/u.test(value) ? " " : ""}${token}`;
  }
  const matched = atMatch[0];
  const tokenStart = atMatch.index + (matched.startsWith("@") ? 0 : 1);
  return `${value.slice(0, tokenStart)}${token}`;
}

/** 解析全部节点 token（含重复），返回 nodeId/label/位置。 */
export function parseFreezoneNodeMentions(value: string): FreezoneNodeMention[] {
  const out: FreezoneNodeMention[] = [];
  for (const match of value.matchAll(NODE_MENTION_PATTERN)) {
    if (match.index === undefined) continue;
    const label = match[1] ?? "";
    const nodeId = match[2]?.trim();
    if (!nodeId) continue;
    const matched = match[0] ?? "";
    const start = match.index + (matched.startsWith("@") ? 0 : 1);
    out.push({ nodeId, label, start, end: start + `@[${label}](${nodeId})`.length });
  }
  return out;
}

/** 收集正文里被提及的 nodeId（去重、保序）。 */
export function freezoneNodeMentionIds(value: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const mention of parseFreezoneNodeMentions(value)) {
    if (seen.has(mention.nodeId)) continue;
    seen.add(mention.nodeId);
    ids.push(mention.nodeId);
  }
  return ids;
}

/** 提交时把 `@[名](id)` 改写为可读的 `[名]`（保留前置空白），作为发给 agent 的正文。 */
export function freezoneNodeMentionText(value: string): string {
  return value.replace(NODE_MENTION_PATTERN, (matched: string, label: string) => {
    const lead = matched.startsWith("@") ? "" : matched.slice(0, 1);
    return `${lead}[${label}]`;
  });
}

/** 从候选列表建 nodeId → 缩略图/片源/列 查表，供编辑器 chip 渲染缩略图与首帧兜底。 */
export function buildFreezoneNodeMentionLookup(
  items: FreezoneNodeSuggestion[],
): FreezoneNodeMentionLookup {
  return new Map(
    items.map((item) => [
      item.nodeId,
      { thumbnailUrl: item.thumbnailUrl, mediaUrl: item.mediaUrl, column: item.column },
    ]),
  );
}

/**
 * 「添加到对话」落地：把一批 nodeId 追加成 draft 里的行内 mention chip。
 * - titleLookup 无该 id（节点已不在画布上）→ 跳过；
 * - draft 已提及 or 同批重复 → 跳过，避免重复 chip。
 * 逐个复用 insertFreezoneNodeMention（无尾随 @query 时即在末尾追加）。
 */
export function appendFreezoneNodeMentions(
  draft: string,
  nodeIds: string[],
  titleLookup: Map<string, string>,
): string {
  const seen = new Set(freezoneNodeMentionIds(draft));
  let result = draft;
  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) continue;
    const title = titleLookup.get(nodeId);
    if (title === undefined) continue;
    result = insertFreezoneNodeMention(result, nodeId, title);
    seen.add(nodeId);
  }
  return result;
}

/** 栏目 → 悬浮预览里显示的中文类型标签。 */
const FREEZONE_NODE_COLUMN_LABEL: Record<AssetBoardColumn, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
};

/**
 * 输入框里引用 chip 的悬浮预览内容。
 * - thumbnailUrl 有值 → 直接 <img>（图片本体 / 视频封面）；
 * - thumbnailUrl 为空但 videoPosterUrl 有值 → 用片源取首帧 <video>（视频没记封面时的兜底）；
 * - 两者都空 → 文本/音频等，走类型占位。
 */
export type FreezoneNodePreviewInfo = {
  label: string;
  thumbnailUrl: string | null;
  /** 无封面的视频 → 用片源取首帧的兜底源；非视频或已有封面为 null。 */
  videoPosterUrl: string | null;
  typeLabel: string;
};

/**
 * 从 chip 自带的 label 与查表 meta 组出预览卡内容：
 * - 图片/视频有缩略图 → 放大展示；视频没记封面 → 用 mediaUrl 取首帧兜底（对齐故事板 VideoThumb）；
 * - 文本/音频等无图 → 只给类型占位；
 * - meta 缺失（节点已不在画布上）→ 类型回落成「引用」，仍展示 label。
 */
export function buildFreezoneNodePreviewInfo(
  label: string,
  meta: { thumbnailUrl: string | null; mediaUrl: string | null; column: AssetBoardColumn } | null,
): FreezoneNodePreviewInfo {
  const thumbnailUrl = meta?.thumbnailUrl ?? null;
  const videoPosterUrl =
    !thumbnailUrl && meta?.column === "video" ? (meta.mediaUrl ?? null) : null;
  return {
    label,
    thumbnailUrl,
    videoPosterUrl,
    typeLabel: meta ? FREEZONE_NODE_COLUMN_LABEL[meta.column] : "引用",
  };
}
