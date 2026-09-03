// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 一条任务日志。字符串是未迁移的调用点直接写的中文；对象形式带 i18n code，
 * text 仍是中文兜底（词条缺失、或老客户端读到新后端时用）。
 */
export type TaskLogEntry =
  | string
  | { text: string; code?: string | null; params?: Record<string, unknown> | null };

export type TaskStatus =
  | "submitting"
  | "queued"
  | "pending"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskState {
  task_key: string;
  task_id: string;
  task_type: string;
  username: string;
  project: string;
  project_id?: string;
  episode: number;
  beat_num: number | null;
  scope: string | null;
  status: TaskStatus;
  progress: number;
  current_task: string;
  /** current_task 的 i18n 词条 key；后端还没迁移的调用点没有这个字段。 */
  current_task_code?: string | null;
  current_task_params?: Record<string, unknown> | null;
  result: unknown | null;
  metadata?: Record<string, unknown> | null;
  error: string | null;
  error_code?: string | null;
  /**
   * 公开契约一直是 `string[]`。带 i18n code 的结构化版本另走 `logs_i18n`，
   * 这样新后端配老前端不会把日志渲染成 `[object Object]`。读的时候用
   * `taskLogLinesOf(task, t)`，别直接挑字段。
   */
  logs: string[];
  logs_i18n?: TaskLogEntry[];
  task_type_label?: string;
  display_name?: string;
  /** false = display_name 是调用方自带的业务名；true/缺省 = 后端按 task_type 拼的中文，前端重拼。 */
  display_name_localizable?: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string;
  expires_at?: string | null;
}

export type StreamHealth = "connecting" | "connected" | "reconnecting" | "polling" | "failed";

export type TaskEvent =
  | { type: "task_updated"; task: TaskState; previous: TaskState | null }
  | { type: "task_complete"; task: TaskState; previous: TaskState | null }
  | { type: "task_failed"; task: TaskState; previous: TaskState | null }
  | { type: "task_removed"; taskKey: string };

export type TaskEventType = TaskEvent["type"];
export type TaskEventListener = (e: TaskEvent) => void;
