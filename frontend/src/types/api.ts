// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export interface OkResponse<T> {
  ok: true;
  data: T;
}

export interface TaskResponse {
  ok: true;
  task_type: string;
  task_id?: string;
  task_key?: string;
  message: string;
  /** message 的 i18n 词条 key；还没迁移的接口没有这个字段，前端回落到 message 的中文。 */
  message_code?: string;
  message_params?: Record<string, unknown>;
  /**
   * Server-computed scope for tasks where the FE can't derive it itself
   * (e.g. `selection_scope(mode_key, beat_indices)` for sketch_regen).
   * Pass scope plus task_id into `useTaskController.start({ scope, taskId })`
   * so the SSE stream URL can filter to the exact task row on first open, and
   * terminal reconciliation does not confuse a previous run with the same
   * scope for the current task.
   */
  scope?: string;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  code?: string;
}

export type ApiResponse<T> = OkResponse<T> | ErrorResponse;
