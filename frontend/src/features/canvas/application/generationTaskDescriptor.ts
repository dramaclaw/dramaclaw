import type { FreezoneJobRef } from '@/api/ops';

type FreezoneTaskType = FreezoneJobRef['task_type'];

export interface GenerationTaskDescriptor {
  generationTaskKey: string;
  generationTaskType: FreezoneTaskType;
  generationTaskJobId: string;
  [key: string]: unknown;
}

// A task submitted in this browser session already has an active waiter. A fresh
// page gets a fresh Set, so persisted handles are eligible for recovery.
const sessionOwnedTaskKeys = new Set<string>();

/**
 * 落到节点上的任务句柄，刷新后由 {@link nodeNeedsGenerationResume} 接着等。
 *
 * 并发 wait 由 `awaitTaskCompletion` 合并成同一个 promise，所以这里**不**把任务
 * 标记成本会话已接管 —— SPA 导航（如进出虾导）后旧等待方可能已经消失，节点仍
 * 需要恢复路径把结果接回来。
 */
export function generationTaskDescriptor(ref: FreezoneJobRef): GenerationTaskDescriptor {
  return {
    generationTaskKey: ref.task_key,
    generationTaskType: ref.task_type,
    generationTaskJobId: ref.job_id,
  };
}

/**
 * 同 {@link generationTaskDescriptor}，但把任务算作本会话已接管，恢复扫描会跳过
 * 它。给「提交方自己会等结果并落盘」的流程用（目前是 HTML 生成），避免提交方与
 * Canvas 的恢复路径同时保存同一份产物。
 */
export function sessionOwnedGenerationTaskDescriptor(
  ref: FreezoneJobRef,
): GenerationTaskDescriptor {
  sessionOwnedTaskKeys.add(ref.task_key);
  return generationTaskDescriptor(ref);
}

export function releaseGenerationTaskOwnership(taskKey: string): void {
  sessionOwnedTaskKeys.delete(taskKey);
}

export function sessionOwnsGenerationTask(taskKey: string): boolean {
  return sessionOwnedTaskKeys.has(taskKey);
}
