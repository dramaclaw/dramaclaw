import { describe, expect, it } from "vitest";

import {
  buildChatTaskBatchNotification,
  resolveChatTaskBatchSummary,
} from "@/features/superchat/task-notification-batch";
import type { TaskState } from "@/task-center/types";

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    task_key: "task:single_video:1",
    task_id: "job-1",
    task_type: "single_video",
    username: "alice",
    project: "demo",
    project_id: "project-1",
    episode: 1,
    beat_num: 1,
    scope: null,
    status: "completed",
    progress: 1,
    current_task: "completed",
    result: null,
    metadata: { batch_id: "video-batch-1", batch_size: "3" },
    error: null,
    logs: [],
    created_at: "",
    updated_at: "",
    completed_at: "",
    ...overrides,
  };
}

describe("resolveChatTaskBatchSummary", () => {
  it("waits until every task in the batch is terminal", () => {
    const tasks = [
      task(),
      task({ task_key: "task:2", task_id: "job-2", beat_num: 2 }),
      task({
        task_key: "task:3",
        task_id: "job-3",
        beat_num: 3,
        status: "running",
      }),
    ];

    expect(resolveChatTaskBatchSummary(tasks, tasks[0])).toBeNull();
  });

  it("summarizes one batch after all tasks settle", () => {
    const tasks = [
      task(),
      task({ task_key: "task:2", task_id: "job-2", beat_num: 2 }),
      task({
        task_key: "task:3",
        task_id: "job-3",
        beat_num: 3,
        status: "failed",
      }),
    ];

    const summary = resolveChatTaskBatchSummary(tasks, tasks[2]);

    expect(summary).toMatchObject({
      batchId: "video-batch-1",
      total: 3,
      completed: 2,
      failed: 1,
      cancelled: 0,
    });
    expect(buildChatTaskBatchNotification(summary!)).toBe(
      "第 1 集视频批次已结束：完成 2/3，失败 1。请在任务中心查看详情后再继续。",
    );
  });

  it("builds one success message for a completed video batch", () => {
    const tasks = [
      task(),
      task({ task_key: "task:2", task_id: "job-2", beat_num: 2 }),
      task({ task_key: "task:3", task_id: "job-3", beat_num: 3 }),
    ];

    const summary = resolveChatTaskBatchSummary(tasks, tasks[2]);

    expect(buildChatTaskBatchNotification(summary!)).toBe(
      "✅ 第 1 集 3 个视频已全部生成完成。你可以让我查看结果，或继续下一步。",
    );
  });

  it("builds one success message after a nine-video queued batch completes", () => {
    const tasks = Array.from({ length: 9 }, (_, index) => task({
      task_key: `task:${index + 1}`,
      task_id: `job-${index + 1}`,
      beat_num: index + 1,
      metadata: { batch_id: "video-batch-9", batch_size: "9" },
    }));

    const summary = resolveChatTaskBatchSummary(tasks, tasks[8]);

    expect(summary).toMatchObject({
      batchId: "video-batch-9",
      total: 9,
      completed: 9,
    });
    expect(buildChatTaskBatchNotification(summary!)).toBe(
      "✅ 第 1 集 9 个视频已全部生成完成。你可以让我查看结果，或继续下一步。",
    );
  });

  it("labels selected regen batches as first frames", () => {
    const tasks = [
      task({ task_type: "selected_regen" }),
      task({ task_key: "task:2", task_id: "job-2", task_type: "selected_regen" }),
      task({ task_key: "task:3", task_id: "job-3", task_type: "selected_regen" }),
    ];

    const summary = resolveChatTaskBatchSummary(tasks, tasks[2]);

    expect(buildChatTaskBatchNotification(summary!)).toBe(
      "✅ 第 1 集 3 个首帧已全部生成完成。你可以让我查看结果，或继续下一步。",
    );
  });

  it("labels sketch grid batches as storyboard grids", () => {
    const tasks = [
      task({ task_type: "sketch_grid_generation" }),
      task({
        task_key: "task:2",
        task_id: "job-2",
        task_type: "sketch_grid_generation",
      }),
      task({
        task_key: "task:3",
        task_id: "job-3",
        task_type: "sketch_grid_generation",
      }),
    ];

    const summary = resolveChatTaskBatchSummary(tasks, tasks[2]);

    expect(buildChatTaskBatchNotification(summary!)).toBe(
      "✅ 第 1 集 3 个草图网格已全部生成完成。你可以让我查看结果，或继续下一步。",
    );
  });

  it("does not aggregate ordinary single tasks", () => {
    const single = task({ metadata: null });

    expect(resolveChatTaskBatchSummary([single], single)).toBeNull();
  });
});
