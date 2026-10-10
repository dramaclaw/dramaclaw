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

export function generationTaskDescriptor(ref: FreezoneJobRef): GenerationTaskDescriptor {
  sessionOwnedTaskKeys.add(ref.task_key);
  return handedOffGenerationTaskDescriptor(ref);
}

/**
 * 同 {@link generationTaskDescriptor}，但**不**把任务算作本会话已接管：提交方只管
 * 提交，等结果与落地全部交给 resumeNodeGeneration——Canvas 扫到节点上的句柄
 * 就会立刻接上去等，跟刷新后恢复走的是同一条路。
 *
 * 给那些提交方活不过任务的流程用：预演台的白模生成从编辑器里发起，而编辑器随时会被
 * 关掉；要是在提交方里 await，关窗就等于丢结果。
 */
export function handedOffGenerationTaskDescriptor(ref: FreezoneJobRef): GenerationTaskDescriptor {
  return {
    generationTaskKey: ref.task_key,
    generationTaskType: ref.task_type,
    generationTaskJobId: ref.job_id,
  };
}

export function releaseGenerationTaskOwnership(taskKey: string): void {
  sessionOwnedTaskKeys.delete(taskKey);
}

export function sessionOwnsGenerationTask(taskKey: string): boolean {
  return sessionOwnedTaskKeys.has(taskKey);
}
