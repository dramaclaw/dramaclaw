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
