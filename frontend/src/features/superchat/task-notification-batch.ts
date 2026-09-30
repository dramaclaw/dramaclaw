import { isTerminal } from "@/task-center/derivations";
import type { TaskState } from "@/task-center/types";

export interface ChatTaskBatchSummary {
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  episode: number;
  taskType: string;
}

function metadataString(task: TaskState, key: string): string {
  const value = task.metadata?.[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

export function taskBatchId(task: TaskState): string {
  return metadataString(task, "batch_id");
}

export function taskBatchSize(task: TaskState): number {
  const value = Number(metadataString(task, "batch_size"));
  return Number.isInteger(value) && value > 1 && value <= 100 ? value : 0;
}

export function resolveChatTaskBatchSummary(
  tasks: Iterable<TaskState>,
  changedTask: TaskState,
): ChatTaskBatchSummary | null {
  const batchId = taskBatchId(changedTask);
  const total = taskBatchSize(changedTask);
  if (!batchId || !total || !isTerminal(changedTask)) return null;

  const batchTasks = [...tasks].filter((task) =>
    taskBatchId(task) === batchId &&
    (task.project_id ?? task.project) === (changedTask.project_id ?? changedTask.project)
  );
  if (batchTasks.length < total || batchTasks.some((task) => !isTerminal(task))) {
    return null;
  }

  const terminalTasks = batchTasks.slice(0, total);
  return {
    batchId,
    total,
    completed: terminalTasks.filter((task) => task.status === "completed").length,
    failed: terminalTasks.filter((task) => task.status === "failed").length,
    cancelled: terminalTasks.filter((task) => task.status === "cancelled").length,
    episode: changedTask.episode,
    taskType: changedTask.task_type,
  };
}

export function buildChatTaskBatchNotification(summary: ChatTaskBatchSummary): string {
  const episodeLabel = summary.episode > 0 ? `第 ${summary.episode} 集` : "";
  const taskLabel = summary.taskType === "single_video"
    ? "视频"
    : summary.taskType === "selected_regen"
      ? "首帧"
      : summary.taskType === "sketch_grid_generation"
        ? "草图网格"
      : "任务";
  if (summary.completed === summary.total) {
    const prefix = episodeLabel ? `${episodeLabel} ` : "";
    return `✅ ${prefix}${summary.total} 个${taskLabel}已全部生成完成。你可以让我查看结果，或继续下一步。`;
  }

  const details = [
    `完成 ${summary.completed}/${summary.total}`,
    summary.failed > 0 ? `失败 ${summary.failed}` : "",
    summary.cancelled > 0 ? `取消 ${summary.cancelled}` : "",
  ].filter(Boolean).join("，");
  return `${episodeLabel}${taskLabel}批次已结束：${details}。请在任务中心查看详情后再继续。`;
}
