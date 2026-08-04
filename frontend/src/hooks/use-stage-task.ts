// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { useCancelTask, useTasks } from "@/lib/queries/tasks";
import { useTaskStream } from "@/hooks/use-task-stream";
import type { TaskStatus } from "@/types/task";

const ACTIVE_STATUSES: TaskStatus[] = ["submitting", "queued", "pending", "starting", "running"];

const LOG_CAP = 200;

interface UseStageTaskOptions {
  taskType: string;
  /**
   * Extra task types to auto-resume on mount. Use when one UI surface drives
   * multiple backend task types that shouldn't step on each other — e.g.
   * script rhythm toggle switches between `script_writer` and
   * `literal_script_writer`. On reconcile, the matching type wins and
   * governs the stream + cancel call until the task terminates.
   */
  alsoReconcile?: string[];
  project: string;
  episode: number;
  invalidateKeys?: QueryKey[];
  onComplete?: (result: unknown) => void;
  onError?: (error: string) => void;
}

interface StageTask {
  started: boolean;
  stream: ReturnType<typeof useTaskStream>;
  logs: string[];
  start: () => void;
  stop: () => Promise<void>;
  stopping: boolean;
}

/**
 * Unified wrapper for per-stage SSE tasks.
 *
 * - Reconciles once on mount: if the server reports this task running,
 *   auto-opens the SSE stream so a page reload mid-generation resumes progress.
 * - `start()` clears logs and opens the stream.
 * - `stop()` closes the stream locally AND calls DELETE /tasks/... so the
 *   backend actually cancels (not just "hide progress").
 * - Accumulates streamed `current_task` strings into a 200-line rolling buffer.
 */
export function useStageTask(opts: UseStageTaskOptions): StageTask {
  const {
    taskType,
    alsoReconcile,
    project,
    episode,
    invalidateKeys,
    onComplete,
    onError,
  } = opts;

  const [started, setStarted] = useState(false);
  const [activeTaskType, setActiveTaskType] = useState(taskType);
  const [logs, setLogs] = useState<string[]>([]);
  const cancelTask = useCancelTask();

  // Reconcile — only on first /tasks payload, not continuously.
  // Filter to this stage's project/episode so the 2s poll doesn't re-fire
  // the effect for unrelated task changes.
  const { data: tasksRes } = useTasks({ project, episode });
  const reconciledRef = useRef(false);
  useEffect(() => {
    if (reconciledRef.current) return;
    if (tasksRes === undefined) return;
    const tasks = tasksRes.data ?? [];
    const candidates = [taskType, ...(alsoReconcile ?? [])];
    const match = tasks.find(
      (t) =>
        candidates.includes(t.task_type) &&
        ACTIVE_STATUSES.includes(t.status),
    );
    if (match) {
      setStarted(true);
      setActiveTaskType(match.task_type);
    }
    reconciledRef.current = true;
  }, [tasksRes, taskType, alsoReconcile, project, episode]);

  const stream = useTaskStream({
    taskType: activeTaskType,
    project,
    episode,
    enabled: started,
    invalidateKeys,
    onComplete: (r) => {
      setStarted(false);
      onComplete?.(r);
    },
    onError: (e) => {
      setStarted(false);
      onError?.(e);
    },
  });

  useEffect(() => {
    if (!stream.currentTask) return;
    setLogs((prev) => {
      if (prev[prev.length - 1] === stream.currentTask) return prev;
      const next = [...prev, stream.currentTask];
      return next.length > LOG_CAP ? next.slice(-LOG_CAP) : next;
    });
  }, [stream.currentTask]);

  const start = () => {
    setLogs([]);
    setActiveTaskType(taskType);
    setStarted(true);
  };

  const stop = async () => {
    try {
      const result = await cancelTask.mutateAsync({
        type: activeTaskType,
        project,
        episode,
      });
      if (result.ok) setStarted(false);
    } catch {
      // Keep the panel visible when cancellation did not complete.
    }
  };

  return { started, stream, logs, start, stop, stopping: cancelTask.isPending };
}
