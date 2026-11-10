// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TaskStatus } from '@/api/tasks';

export class TaskCompletionError extends Error {
  constructor(
    message: string,
    public readonly status: TaskStatus,
    public readonly taskKey: string,
  ) {
    super(message);
    this.name = "TaskCompletionError";
  }
}

/** 用户主动终止的任务不是错误 —— 用于跳过错误弹窗/错误横幅。 */
export function isTaskCancelledError(error: unknown): boolean {
  return error instanceof TaskCompletionError && error.status === "cancelled";
}
