// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from "i18next";

export interface ScriptFeedback {
  type: "success" | "warning";
  key: string;
  values?: Record<string, string | number>;
}

export function getScriptReviewFeedback(result: unknown): ScriptFeedback {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (record.review_passed === false) {
      const summary =
        typeof record.review_summary === "string" && record.review_summary.trim()
          ? record.review_summary.trim()
          : i18n.t("episode.script.reviewIssuesFallback");
      return {
        type: "warning",
        key: "episode.script.scriptReviewFailed",
        values: { summary },
      };
    }
  }
  return { type: "success", key: "episode.script.scriptReviewPassed" };
}

export function mergeTaskLogs(
  existing: readonly string[],
  incoming: readonly string[] | null | undefined,
  limit = 200,
): string[] {
  if (!incoming?.length) return [...existing];
  const out = [...existing];
  for (const line of incoming) {
    if (!line || out[out.length - 1] === line || out.includes(line)) continue;
    out.push(line);
  }
  return out.slice(-limit);
}
