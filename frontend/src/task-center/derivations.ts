// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TaskLogEntry, TaskState, TaskStatus } from "./types";
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
  // display_name_localizable === false 表示这串是用户自定义名称（画布名、素材名之类），
  // 翻译反而是错的，原样显示。后端默认给 true：它自己拼的和 freezone/scripts 的
  // task_display 传的都是写死中文，英文界面下必须在这里按 task_type / metadata 重拼。
  if (t.display_name && t.display_name_localizable === false) return t.display_name;

  const typeLabel = taskTypeLabel(t, tFn);
  const sceneName = metaString(t, "scene_name");

  if (t.task_type === "stage_asset") {
    const step = metaString(t, "step");
    const parts = [typeLabel, sceneName];
    if (step) parts.push(tFn(`tasks.stageAssetSteps.${step}`, { defaultValue: step }));
    return parts.filter(Boolean).join(" · ");
  }

  const parts = [typeLabel];
  // 场景任务（360 全景等）的 display_name 原本是「生成 360 全景 · 场景名」，重拼时
  // 不带上 scene_name 就把场景名弄丢了。scene_name 是场景标识，不翻译。
  if (sceneName) parts.push(sceneName);
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
  t: {
    status: TaskStatus;
    current_task?: string | null;
    current_task_code?: string | null;
    current_task_params?: Record<string, unknown> | null;
  },
  tFn: TFn,
): string => {
  const raw = String(t.current_task ?? "").trim();
  if (!raw) return "";
  const terminal =
    t.status === "completed" || t.status === "failed" || t.status === "cancelled";
  if (terminal && TERMINAL_CURRENT_TASK_SENTINELS.has(raw.toLowerCase())) {
    return tFn(`taskCenter.status.${t.status}`);
  }
  // 后端给了 code 就按词条翻；没给的（历史任务、还没迁移的调用点）照旧回显
  // 后端那句中文，所以迁移可以一处一处来，不用一次改完所有 415 处。
  if (t.current_task_code) {
    return tFn(t.current_task_code, {
      defaultValue: raw,
      ...(t.current_task_params ?? {}),
    });
  }
  return raw;
};

/**
 * 把一批日志压成已翻译的字符串数组。
 *
 * 结构化条目只在「后端 → 前端入口」这一层存在：解析响应时立刻翻成字符串，
 * 下游所有消费点（join、逐行比较、滚动 buffer）继续按 string[] 处理，不用
 * 跟着改。代价是切语言时已经拿到手的旧日志不会重译 —— 进度日志本来就是流式
 * 的，切完语言后新来的行就是新语言，任务中心也会重新拉取。
 */
export const taskLogLines = (logs: unknown, tFn: TFn): string[] =>
  Array.isArray(logs)
    ? logs
        .filter((x): x is TaskLogEntry => typeof x === "string" || !!x)
        .map((entry) => taskLogText(entry, tFn))
    : [];

/**
 * 任务日志的读取入口：优先结构化的 `logs_i18n`，没有再回落到 `logs`。
 *
 * `logs` 的公开契约一直是 `string[]`（老前端直接 `logs.join("\n")`），所以后端
 * 不能把 `{text, code, params}` 塞回那个字段——滚动发布期间新后端配老前端就会
 * 显示成 `[object Object]`。带 code 的那份走 `logs_i18n`，只有认识它的前端才读。
 * 反过来，老后端不发 `logs_i18n`，这里就直接用 `logs` 里的中文，同样不用原子部署。
 */
export const taskLogLinesOf = (
  source: { logs?: unknown; logs_i18n?: unknown } | null | undefined,
  tFn: TFn,
): string[] =>
  taskLogLines(
    Array.isArray(source?.logs_i18n) ? source.logs_i18n : source?.logs,
    tFn,
  );

export const taskLogText = (entry: TaskLogEntry, tFn: TFn): string => {
  if (typeof entry === "string") return entry;
  const text = String(entry?.text ?? "");
  if (!entry?.code) return text;
  return tFn(entry.code, { defaultValue: text, ...(entry.params ?? {}) });
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
