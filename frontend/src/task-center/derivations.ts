// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TaskState, TaskStatus } from "./types";
import { stageForTaskType } from "@/lib/episode-stage-registry";
import type { TFn } from "@/lib/i18n-types";

export const isTerminal = (t: TaskState): boolean =>
  t.status === "completed" || t.status === "failed" || t.status === "cancelled";

export const isActive = (t: TaskState): boolean =>
  t.status === "submitting" ||
  t.status === "queued" ||
  t.status === "pending" ||
  t.status === "starting" ||
  t.status === "running";

export const ageMs = (t: TaskState, now: number = Date.now()): number =>
  now - Date.parse(t.updated_at);

function isInternalRunScope(scope: string | null | undefined): boolean {
  return /^scene_run_[a-z0-9]+$/i.test(scope ?? "") || /^prop_run_[a-z0-9]+$/i.test(scope ?? "");
}

function metaString(t: TaskState, key: string): string {
  const value = t.metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 任务类型名。后端 `task_type_label` / `display_name` 都是中文，英文界面下不能直接用；
 * 词条里有 `tasks.types.<task_type>` 就以词条为准，没有才退回后端那份（新任务类型上线
 * 时前端还没补词条，宁可显示中文也别显示裸 key）。
 */
export const taskTypeLabel = (t: TaskState, tFn: TFn): string =>
  tFn(`tasks.types.${t.task_type}`, { defaultValue: t.task_type_label || t.task_type });

export const displayLabel = (t: TaskState, tFn: TFn): string => {
  // 调用方自带的 display_name 是业务内容（画布名、素材名之类），原样显示；
  // display_name_localizable 说明那串只是后端按 task_type 拼的中文，这里重拼。
  if (t.display_name && t.display_name_localizable === false) return t.display_name;

  const typeLabel = taskTypeLabel(t, tFn);

  if (t.task_type === "stage_asset") {
    const step = metaString(t, "step");
    const parts = [typeLabel, metaString(t, "scene_name")];
    if (step) parts.push(tFn(`tasks.stageAssetSteps.${step}`, { defaultValue: step }));
    return parts.filter(Boolean).join(" · ");
  }

  const parts = [typeLabel];
  if (t.episode > 0) parts.push(`ep${t.episode}`);
  if (t.beat_num != null) parts.push(`beat ${t.beat_num}`);
  if (t.scope && !isInternalRunScope(t.scope)) parts.push(t.scope);
  return parts.join(" · ");
};

/**
 * 后端 run_core 收尾时把 current_task 写成中文「完成」（还有历史上的 completed/done），
 * 前端原样回显就成了英文界面里的一处中文。终态只认状态词条，别回显这几个哨兵值；
 * 其余进度文案仍是后端实时给的内容，照原样显示。
 */
const TERMINAL_CURRENT_TASK_SENTINELS = new Set(["完成", "completed", "done"]); // i18n-exempt —— 后端哨兵值

export const currentTaskText = (
  t: { status: TaskStatus; current_task?: string | null },
  tFn: TFn,
): string => {
  const raw = String(t.current_task ?? "").trim();
  if (!raw) return "";
  const terminal =
    t.status === "completed" || t.status === "failed" || t.status === "cancelled";
  if (terminal && TERMINAL_CURRENT_TASK_SENTINELS.has(raw.toLowerCase())) {
    return tFn(`taskCenter.status.${t.status}`);
  }
  return raw;
};

export interface OriginDeepLink {
  to: string;
  params: Record<string, string>;
}

export const originDeepLink = (t: TaskState): OriginDeepLink | null => {
  const stage = stageForTaskType(t.task_type);
  if (!stage) return null;
  // stage.routeSegment already starts with "/" (e.g., "/sketches")
  return {
    to: `/projects/$project/episodes/$episode${stage.routeSegment}`,
    params: { project: t.project_id ?? t.project, episode: String(t.episode) },
  };
};
