// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isActive as isActiveTask } from '@/task-center/derivations';
import { useTaskCenterStore } from '@/task-center/store';
import type { TaskState } from '@/task-center/types';

export interface NodeGenerationTaskState {
  taskKey: string;
  task: TaskState | null;
  taskIsActive: boolean;
  waitingForTaskRecord: boolean;
  optimisticOnly: boolean;
  isGenerating: boolean;
}

// 刚提交后，节点已写入 taskKey，但任务要经一次接口往返 + SSE/轮询才会出现在
// task-center 里。这段空窗内 `task` 还是 null，若此时既不算 optimistic（taskKey
// 已有）又不算 waiting（task-center 早已 hydrated），isGenerating 会瞬间掉回
// false，loading 遮罩闪一下才回来。用 generationStartedAt 给一个「刚开跑」的
// 宽限窗把这段空窗补上——任务一旦真正出现在 store 就改用其真实活跃态，宽限不再
// 参与；窗外（如刷新恢复一条早已被裁剪的旧任务）则不再信任过期的本地标志。
const RECENTLY_STARTED_GRACE_MS = 10_000;

export function useNodeGenerationTaskState(data: unknown): NodeGenerationTaskState {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const taskKey =
    typeof record.generationTaskKey === 'string' ? record.generationTaskKey.trim() : '';
  const task = useTaskCenterStore((state) =>
    taskKey ? state.tasks.get(taskKey) ?? null : null,
  );
  const taskCenterHydrated = useTaskCenterStore((state) => state.isHydrated);
  const taskIsActive = task ? isActiveTask(task) : false;
  const localGenerating = record.isGenerating === true;
  const startedAt =
    typeof record.generationStartedAt === 'number' ? record.generationStartedAt : null;
  const recentlyStarted =
    startedAt != null && Date.now() - startedAt < RECENTLY_STARTED_GRACE_MS;
  const waitingForTaskRecord =
    localGenerating &&
    taskKey.length > 0 &&
    !task &&
    (!taskCenterHydrated || recentlyStarted);
  const optimisticOnly = localGenerating && taskKey.length === 0;

  return {
    taskKey,
    task,
    taskIsActive,
    waitingForTaskRecord,
    optimisticOnly,
    isGenerating: record.generationOwner === 'server' || taskIsActive || waitingForTaskRecord || optimisticOnly,
  };
}
