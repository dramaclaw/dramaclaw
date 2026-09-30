// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezoneAgentConfigPayload } from "@/lib/queries/freezone-agent-config";

export type FreezoneSkillSuggestion = {
  id: string;
  label: string;
  category: string;
  description: string;
  keywords: string[];
};

export type FreezoneSkillMention = {
  skillId: string;
  start: number;
  end: number;
};

export type FreezoneSkillMentionTextSegment =
  | { type: "text"; text: string }
  | { type: "skill"; skillId: string };

export type FreezoneSkillEmptyAction = {
  id: "summarize-canvas" | "create-with-agent";
  label: string;
  prompt: string;
};

export const FREEZONE_SKILL_EMPTY_ACTIONS: FreezoneSkillEmptyAction[] = [
  {
    id: "summarize-canvas",
    label: "总结画布为 Skill",
    prompt: "把当前画布总结成一个可复用 Skill",
  },
  {
    id: "create-with-agent",
    label: "和 Agent 创建 Skill",
    prompt: "帮我创建一个 Skill：",
  },
];

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keywords: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const keyword = item.trim();
      if (keyword) keywords.push(keyword);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const keyword = readString(record.keyword) || readString(record.text) || readString(record.value);
    if (keyword) keywords.push(keyword);
  }
  return keywords;
}

function hasRecipeBoundary(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => readString(item));
}

export function toFreezoneSkillSuggestions(
  items: FreezoneAgentConfigPayload[] | undefined,
): FreezoneSkillSuggestion[] {
  if (!items?.length) return [];
  return items.flatMap((item) => {
    const id = readString(item.id);
    if (!id || item.enabled === false) return [];
    if (!hasRecipeBoundary(item.allowed_recipe_ids ?? item.allowedRecipeIds)) return [];
    const triggers = item.triggers && typeof item.triggers === "object"
      ? item.triggers as Record<string, unknown>
      : {};
    return [{
      id,
      label:
        readString(item.name)
        || readString(item.display_name)
        || readString(item.displayName)
        || readString(item.title)
        || id,
      category: readString(item.category),
      description: readString(item.description),
      keywords: readKeywords(triggers.keywords),
    }];
  });
}

export function getFreezoneSkillSlashQuery(value: string): string | null {
  const match = value.match(/(?:^|\s)\/([^\s/]*)$/u);
  return match ? match[1].trim().toLowerCase() : null;
}

export function filterFreezoneSkillSuggestions(
  suggestions: FreezoneSkillSuggestion[],
  query: string,
): FreezoneSkillSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return suggestions;
  return suggestions.filter((suggestion) => {
    const haystack = [
      suggestion.id,
      suggestion.label,
      suggestion.category,
      suggestion.description,
      ...suggestion.keywords,
    ].join("\n").toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function insertFreezoneSkillMention(value: string, skillId: string): string {
  const replacement = `/${skillId} `;
  const slashTokenMatch = value.match(/(?:^|\s)\/([^\s/]*)$/u);
  if (!slashTokenMatch || slashTokenMatch.index === undefined) {
    return `${value}${value && !/\s$/u.test(value) ? " " : ""}${replacement}`;
  }
  const matchedToken = slashTokenMatch[0];
  const tokenStart = slashTokenMatch.index + (matchedToken.startsWith("/") ? 0 : 1);
  return `${value.slice(0, tokenStart)}${replacement}`;
}

export function insertFreezoneSkillEmptyActionPrompt(value: string, prompt: string): string {
  const slashTokenMatch = value.match(/(?:^|\s)\/([^\s/]*)$/u);
  if (!slashTokenMatch || slashTokenMatch.index === undefined) return prompt;
  const matchedToken = slashTokenMatch[0];
  const tokenStart = slashTokenMatch.index + (matchedToken.startsWith("/") ? 0 : 1);
  return `${value.slice(0, tokenStart)}${prompt}`;
}

export function findFreezoneSkillMention(value: string): FreezoneSkillMention | null {
  const matches = value.matchAll(/(?:^|\s)\/([^\s/]+)(?=\s|$)/gu);
  let latest: FreezoneSkillMention | null = null;
  for (const match of matches) {
    if (match.index === undefined) continue;
    const matchedToken = match[0] ?? "";
    const skillId = match[1]?.trim();
    if (!skillId) continue;
    const start = match.index + (matchedToken.startsWith("/") ? 0 : 1);
    latest = {
      skillId,
      start,
      end: start + skillId.length + 1,
    };
  }
  return latest;
}

export function removeFreezoneSkillMention(
  value: string,
  mention: FreezoneSkillMention | null,
): string {
  if (!mention) return value;
  const before = value.slice(0, mention.start);
  const after = value.slice(mention.end);
  if (before.length === 0) return after.trimStart();
  if (after.length === 0) return before.trimEnd();
  if (/\s$/u.test(before) && /^\s/u.test(after)) return `${before}${after.trimStart()}`;
  return `${before}${after}`;
}

export function splitFreezoneSkillMentionText(value: string): FreezoneSkillMentionTextSegment[] {
  const segments: FreezoneSkillMentionTextSegment[] = [];
  let cursor = 0;
  const matches = value.matchAll(/(?:^|\s)\/([^\s/]+)(?=\s|$)/gu);
  for (const match of matches) {
    if (match.index === undefined) continue;
    const matchedToken = match[0] ?? "";
    const skillId = match[1]?.trim();
    if (!skillId) continue;
    const tokenStart = match.index + (matchedToken.startsWith("/") ? 0 : 1);
    const tokenEnd = tokenStart + skillId.length + 1;
    if (tokenStart > cursor) {
      segments.push({ type: "text", text: value.slice(cursor, tokenStart) });
    }
    segments.push({ type: "skill", skillId });
    cursor = tokenEnd;
  }
  if (cursor < value.length) {
    segments.push({ type: "text", text: value.slice(cursor) });
  }
  return segments.length > 0 ? segments : [{ type: "text", text: value }];
}

export function moveFreezoneSkillSuggestionIndex(
  currentIndex: number,
  offset: number,
  itemCount: number,
): number {
  if (itemCount <= 0) return 0;
  const normalizedCurrent = currentIndex >= 0 && currentIndex < itemCount ? currentIndex : 0;
  return (normalizedCurrent + offset + itemCount) % itemCount;
}

export function shouldShowFreezoneSkillSuggestionMenu({
  explicitOpen = false,
  isFreezoneLayout,
  slashQuery,
}: {
  explicitOpen?: boolean;
  isFreezoneLayout: boolean;
  slashQuery: string | null;
}): boolean {
  return isFreezoneLayout && (explicitOpen || slashQuery !== null);
}
