// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export type TaskStatus =
  | "submitting"
  | "queued"
  | "pending"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  task_type: string;
  username: string;
  project: string;
  project_id?: string;
  episode: number;
  beat_num?: number;
  scope?: string;
  status: TaskStatus;
  progress: number;
  current_task?: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
  error?: string;
  logs?: string[];
  task_type_label?: string;
  display_name?: string;
}

export interface TaskStreamEvent {
  status: TaskStatus;
  progress: number;
  current_task?: string;
  result?: unknown;
  error?: string;
  error_code?: string | null;
  logs?: string[];
}

// Re-export the task-center canonical types so new code can import from either
// `@/types/task` or `@/task-center/types` and get the same truth.
export type { TaskState } from "@/task-center/types";
