// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

import type { FormatCheck, FormatCheckIssue } from "@/lib/queries/ingest";

/**
 * 剧本格式预检的文案本地化。
 *
 * 后端 `screenplay_quality.py` 只产中文串（summary/message/fix），英文界面下会
 * 原样漏出中文。它同时带了 `summary_code` / `issue.code` / `params`，所以这里按
 * code 查 i18n，把后端那份中文当 defaultValue —— 新增了后端 code 而前端还没补
 * key 时，退回中文而不是显示成裸 key。
 */

const SLOT_LABEL_KEYS: Record<string, string> = {
  location: "ingest.formatCheck.slot.location",
  time: "ingest.formatCheck.slot.time",
  interior_exterior: "ingest.formatCheck.slot.interiorExterior",
};

const SLOT_PLACEHOLDER_KEYS: Record<string, string> = {
  location: "ingest.formatCheck.placeholder.location",
  time: "ingest.formatCheck.placeholder.time",
  interior_exterior: "ingest.formatCheck.placeholder.interiorExterior",
};

function camel(code: string): string {
  return code.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 重拼「建议写成这样」的示例。后端拼好的那份是中文（含「地点：」和 [日/夜] 之类
 * 的中文占位符），只有 header/location 这些用户原文可以直接复用。
 */
function buildSuggestion(params: Record<string, unknown>, t: TFunction): string {
  const header = asString(params.header);
  const location = asString(params.location);
  const timeOfDay = asString(params.time_of_day);
  const interiorExterior = asString(params.interior_exterior);
  const missingSlots = asStringArray(params.missing_slots);

  if (params.labeled_form === true && location) {
    return t("ingest.formatCheck.suggestionLabeled", {
      header,
      location,
      time: timeOfDay || t(SLOT_PLACEHOLDER_KEYS.time),
      interiorExterior: interiorExterior || t(SLOT_PLACEHOLDER_KEYS.interior_exterior),
    });
  }

  const placeholders = missingSlots
    .map((slot) => SLOT_PLACEHOLDER_KEYS[slot])
    .filter(Boolean)
    .map((key) => t(key));
  return [header, ...placeholders].join(" ");
}

function localizeIssue(issue: FormatCheckIssue, t: TFunction): FormatCheckIssue {
  const params = (issue.params ?? {}) as Record<string, unknown>;

  // 行级场景头问题：三个 code 共用「场景头 X 缺少 Y」这一句，靠 params.header 区分
  // ——同一个 code(scene_headers_missing_time / missing_interior_exterior)在报告级
  // 还有一条不带 header 的通用文案，两者不能共用 key。
  if (asString(params.header)) {
    const missing = asStringArray(params.missing_slots)
      .map((slot) => SLOT_LABEL_KEYS[slot])
      .filter(Boolean)
      .map((key) => t(key))
      .join(t("ingest.formatCheck.slotSeparator"));
    return {
      ...issue,
      message: t("ingest.formatCheck.issue.sceneHeaderMissingSlots.message", {
        defaultValue: issue.message,
        header: asString(params.header),
        missing,
      }),
      fix: t("ingest.formatCheck.issue.sceneHeaderMissingSlots.fix", {
        defaultValue: issue.fix,
        suggestion: buildSuggestion(params, t),
      }),
    };
  }

  const base = `ingest.formatCheck.issue.${camel(issue.code)}`;
  const interpolation: Record<string, unknown> = {
    ...params,
    title: asString(params.title) || t("ingest.formatCheck.untitledChapter"),
  };
  return {
    ...issue,
    message: t(`${base}.message`, { defaultValue: issue.message, ...interpolation }),
    fix: t(`${base}.fix`, { defaultValue: issue.fix, ...interpolation }),
  };
}

function localizeSummary(formatCheck: FormatCheck, t: TFunction): string {
  if (!formatCheck.summary_code) return formatCheck.summary;
  return t(`ingest.formatCheck.summary.${camel(formatCheck.summary_code)}`, {
    defaultValue: formatCheck.summary,
    ...(formatCheck.summary_params ?? {}),
  });
}

export function localizeFormatCheck(
  formatCheck: FormatCheck | null | undefined,
  t: TFunction,
): FormatCheck | null {
  if (!formatCheck) return null;
  return {
    ...formatCheck,
    summary: localizeSummary(formatCheck, t),
    issues: (formatCheck.issues ?? []).map((issue) => localizeIssue(issue, t)),
  };
}
