// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";

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
  /**
   * 任务中心已经接管本项目、但首轮 `GET /tasks` 还没回来，`isActive` 此刻不可信
   * （硬刷新后 store 初始为空，任何任务都会被判成「没在跑」）。触发类控件应该一并
   * 禁用，避免重复入队。
   *
   * 没有 TaskCenterProvider 在跑时恒为 false——那种场景下永远等不到补水，
   * 认它只会把按钮永久禁死。
   */
  isRestoring: boolean;
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
  // provider 在开始补水前就会 setProject，所以 projectId 非空即代表「有人在管，
  // 补水一定会到」；为空则说明压根没挂 provider，不能靠这个标志禁按钮。
  const isRestoring = useTaskCenterStore(
    (state) => state.projectId != null && !state.isHydrated,
  );
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // 本轮乐观窗口里是否已经认领过任务中心的记录。
  const sawTaskRef = useRef(false);

  useEffect(() => {
    if (task) {
      // 任务真出现在任务中心，本地乐观标记退场，之后完全以任务中心为准。
      sawTaskRef.current = true;
      setStartedAt(null);
      return;
    }
    // 认领过的任务又消失了 = 它已经跑完/失败/被取消。这里必须主动收尾：
    // SSE 有可能比入队接口的响应先到，那样 markStarted() 是在任务出现之后才被
    // 调用的，`task` 不会再变化，光靠上面那条分支清不掉乐观标记，按钮会一直转
    // 到 15s 超时。
    if (sawTaskRef.current) {
      sawTaskRef.current = false;
      setStartedAt(null);
    }
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
    isRestoring,
    progress: task?.progress ?? 0,
    currentTask: task?.current_task ?? "",
    markStarted,
  };
}
