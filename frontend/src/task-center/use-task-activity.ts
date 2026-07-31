// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useState } from "react";

import { isActive as isActiveTask } from "./derivations";
import { useTaskCenterStore } from "./store";
import type { TaskState } from "./types";

/**
 * 接口已受理、但任务还没进任务中心的空窗兜底时长。
 *
 * 入队接口返回后要经一次 SSE/轮询往返任务才会出现在 store 里；这段空窗如果不认，
 * 按钮的 loading 会闪一下就掉回去。反过来，如果任务因为丢事件/被裁剪始终没出现，
 * 到点也必须收回 loading，否则按钮就永远转下去了。
 */
const OPTIMISTIC_GRACE_MS = 15_000;

/** 任务中心里该类型第一条仍在跑的任务；没有则 null。 */
export function useActiveTaskOfType(
  taskType: string,
  options: { episode?: number } = {},
): TaskState | null {
  const { episode } = options;
  return useTaskCenterStore(
    useCallback(
      (state) => {
        for (const task of state.tasks.values()) {
          if (task.task_type !== taskType) continue;
          if (episode !== undefined && task.episode !== episode) continue;
          if (isActiveTask(task)) return task;
        }
        return null;
      },
      [taskType, episode],
    ),
  );
}

export interface TaskActivity {
  /** 任务中心里的活跃任务记录；处于乐观空窗时为 null。 */
  task: TaskState | null;
  /** 是否应该展示 loading。 */
  isActive: boolean;
  /** 0~1。 */
  progress: number;
  /** 后端回报的当前步骤文案。 */
  currentTask: string;
  /** 入队接口成功返回后调用，用于兜住任务进任务中心前的空窗。 */
  markStarted: () => void;
}

/**
 * 把某类项目级任务的 loading 状态绑到任务中心上。
 *
 * 和只用组件本地 state 的写法相比，关键差别是刷新后仍然准确——任务中心启动时会
 * 从 `GET /tasks` 拉一次全量，所以后台还在跑的任务能被重新认出来。
 */
export function useTaskActivity(
  taskType: string,
  options: { episode?: number } = {},
): TaskActivity {
  const task = useActiveTaskOfType(taskType, options);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // 任务一旦真出现在任务中心，本地乐观标记就退场，之后完全以任务中心为准
  // （包括它变成终态时的收尾）。
  useEffect(() => {
    if (task) setStartedAt(null);
  }, [task]);

  useEffect(() => {
    if (startedAt == null) return;
    const timer = window.setTimeout(() => setStartedAt(null), OPTIMISTIC_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [startedAt]);

  const markStarted = useCallback(() => setStartedAt(Date.now()), []);

  return {
    task,
    isActive: task != null || startedAt != null,
    progress: task?.progress ?? 0,
    currentTask: task?.current_task ?? "",
    markStarted,
  };
}
