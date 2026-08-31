// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCallback, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ListChecks,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";

import {
  useCancelTask,
  useClearCompleted,
  useDeleteTask,
  useTasks,
} from "@/lib/queries/tasks";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { TaskListSkeleton } from "@/components/skeletons";
import { cn } from "@/lib/utils";
import { stageForTaskType } from "@/lib/episode-stage-registry";
import { currentTaskText } from "@/task-center/derivations";
import { TASK_TYPES } from "@/lib/task-types";
import type { Task, TaskStatus } from "@/types/task";

// Map a backend task_type → the most relevant FE route under a project.
function taskDeepLink(task: Task): string | null {
  const { episode, task_type } = task;
  const project = task.project_id ?? task.project;

  // Project-level tasks (no episode)
  if (task_type === TASK_TYPES.BUILD_CHARACTERS) {
    return `/projects/${project}/characters`;
  }
  if (task_type === TASK_TYPES.INGEST_FAST) {
    return `/projects/${project}/ingest`;
  }
  if (task_type === TASK_TYPES.BUILD_EPISODES) {
    return `/projects/${project}/episodes`;
  }
  if (task_type === TASK_TYPES.CHARACTER_PORTRAIT) {
    return `/projects/${project}/characters`;
  }
  if (
    task_type === TASK_TYPES.IDENTITY_IMAGE ||
    task_type === TASK_TYPES.IDENTITY_PORTRAIT
  ) {
    return `/projects/${project}/characters`;
  }

  if (!episode || episode <= 0) return null;

  const base = `/projects/${project}/episodes/${episode}`;
  const stage = stageForTaskType(task_type);
  if (stage) return `${base}${stage.routeSegment}`;
  return base; // unknown task type — at least land on the episode shell
}

const STATUS_KEYS: Record<TaskStatus, string> = {
  submitting: "tasks.status.submitting",
  queued: "tasks.status.queued",
  pending: "tasks.status.pending",
  starting: "tasks.status.starting",
  running: "tasks.status.running",
  completed: "tasks.status.completed",
  failed: "tasks.status.failed",
  cancelled: "tasks.status.cancelled",
};

function isActiveTaskStatus(status: TaskStatus): boolean {
  return (
    status === "submitting" ||
    status === "queued" ||
    status === "pending" ||
    status === "starting" ||
    status === "running"
  );
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function TaskRow({
  task,
  onCancel,
  onDelete,
  cancelling,
  deleting,
  outOfProject,
}: {
  task: Task;
  onCancel: () => void;
  onDelete: () => void;
  cancelling: boolean;
  deleting: boolean;
  outOfProject?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const deepLink = taskDeepLink(task);

  const hasDetail =
    (task.result !== undefined && task.result !== null) ||
    task.error ||
    (task.logs && task.logs.length > 0);

  return (
    <div
      className={cn(
        "rounded-[8px] border border-white/[0.1]",
        outOfProject && "border-dashed opacity-70",
      )}
    >
      <div
        className={`flex items-center gap-3 px-4 py-3 ${hasDetail ? "cursor-pointer" : ""}`}
        onClick={() => {
          if (hasDetail) setExpanded((prev) => !prev);
        }}
      >
        {/* Expand toggle */}
        <span className="w-4 shrink-0">
          {hasDetail &&
            (expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            ))}
        </span>

        {/* Left column: type + project/episode/scope + status */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-4">
            <span className="shrink-0 truncate text-xs font-medium w-36">
              {task.task_type}
            </span>
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              {task.project} / Ep.{task.episode}
              {task.beat_num != null && ` / B${task.beat_num}`}
            </span>
            {task.scope && (
              <span className="shrink-0 truncate text-xs text-muted-foreground/70">
                {task.scope}
              </span>
            )}
            {/* Status badge */}
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 rounded-[4px] border h-5 px-2 text-[11px]",
                task.status === "completed" && "border-primary/40 text-primary bg-transparent",
                (task.status === "submitting" || task.status === "queued" || task.status === "pending" || task.status === "starting") && "border-white/[0.08] text-muted-foreground/80 bg-transparent",
                task.status === "running" && "border-primary/40 text-primary bg-primary/[0.05]",
                task.status === "failed" && "border-destructive/40 text-destructive bg-transparent",
              )}
            >
              {t(STATUS_KEYS[task.status])}
            </Badge>
          </div>
          {/* Progress / detail on same line */}
          {task.status === "running" ? (
            <div className="mt-1 flex items-center gap-4">
              <span className="shrink-0 truncate text-[11px] text-muted-foreground/80">
                {currentTaskText(task, t)}
              </span>
              <Progress value={task.progress * 100} className="shrink-0 w-28 h-[3px] [&>div]:h-[3px] [&>div]:gap-0" />
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
                {Math.round(task.progress * 100)}%
              </span>
            </div>
          ) : task.current_task ? (
            <div className="mt-1">
              <span className="truncate text-[11px] text-muted-foreground/70">
                {currentTaskText(task, t)}
              </span>
            </div>
          ) : task.error ? (
            <div className="mt-1">
              <span className="truncate text-[11px] text-destructive/80">
                {task.error}
              </span>
            </div>
          ) : null}
        </div>

        {/* Action buttons */}
        <div className="flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
          {/* Deep link to the task's owning page */}
          {deepLink && (
            <Button variant="ghost" size="icon-sm" render={<Link to={deepLink} />}>
              <ExternalLink className="size-3.5" />
            </Button>
          )}

          {/* Cancel button for running/pending tasks */}
          {isActiveTaskStatus(task.status) && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onCancel}
              disabled={cancelling}
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <XCircle className="size-3.5" />
            </Button>
          )}

          {/* Delete button for completed/failed tasks */}
          {isTerminalTaskStatus(task.status) && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              disabled={deleting}
              className="text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Expanded detail section */}
      <AnimatePresence>
        {expanded && hasDetail && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/[0.06] bg-white/[0.015] px-4 py-3 space-y-4">
              {task.error && (
                <div>
                  <p className="mb-2.5 text-xs font-medium text-destructive">Error</p>
                  <pre className="whitespace-pre-wrap rounded-[8px] border border-white/[0.06] bg-destructive/10 p-2.5 text-xs text-destructive">
                    {task.error}
                  </pre>
                </div>
              )}
              {task.logs && task.logs.length > 0 && (
                <div>
                  <p className="mb-2.5 text-xs font-medium text-muted-foreground">
                    {t("tasks.logs")}
                  </p>
                  <div className="max-h-48 overflow-auto rounded-[8px] border border-white/[0.06] bg-white/[0.04] p-2.5">
                    {task.logs.map((line, i) => (
                      <p key={i} className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                        {line}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {task.result !== undefined && task.result !== null && (
                <div>
                  <p className="mb-2.5 text-xs font-medium text-muted-foreground">
                    {t("tasks.resultLog")}
                  </p>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-[8px] border border-white/[0.06] bg-white/[0.04] p-2.5 font-mono text-xs">
                    {typeof task.result === "string"
                      ? task.result
                      : JSON.stringify(task.result, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TasksPage() {
  const { t } = useTranslation();
  const { project } = Route.useParams();

  const { data: tasksRes, isLoading, refetch } = useTasks({ project });
  const cancelTask = useCancelTask();
  const clearCompleted = useClearCompleted(project);
  const deleteTask = useDeleteTask();

  const tasks = useMemo(() => tasksRes?.data ?? [], [tasksRes?.data]);
  const hasRunning = tasks.some((tk) => isActiveTaskStatus(tk.status));

  const handleCancel = useCallback(
    async (task: Task) => {
      try {
        const result = await cancelTask.mutateAsync({
          type: task.task_type,
          project: task.project_id ?? task.project,
          episode: task.episode,
          beatNum: task.beat_num ?? undefined,
          scope: task.scope ?? undefined,
        });
        if (result.ok) toast.success(result.message ?? t("tasks.cancelled"));
      } catch {
        toast.error(t("common.error"));
      }
    },
    [cancelTask, t],
  );

  const handleDelete = useCallback(
    async (task: Task) => {
      try {
        await deleteTask.mutateAsync({
          type: task.task_type,
          project: task.project_id ?? task.project,
          episode: task.episode,
        });
        toast.success(t("tasks.deleted"));
      } catch {
        toast.error(t("common.error"));
      }
    },
    [deleteTask, t],
  );

  const handleClearCompleted = useCallback(async () => {
    try {
      await clearCompleted.mutateAsync();
      toast.success(t("tasks.cleared"));
    } catch {
      toast.error(t("common.error"));
    }
  }, [clearCompleted, t]);

  const hasCompleted = tasks.some((tk) => tk.status === "completed");

  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-3 border-b border-border/30 bg-background px-9 py-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ListChecks className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
                {t("nav.tasks")}
              </h1>
              {hasRunning && (
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
              )}
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t("tasks.taskCount", { count: tasks.length })}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => { await refetch(); toast.success(t("common.refreshed")); }}
            className="h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none transition-transform hover:bg-white/[0.04] active:scale-95 dark:bg-transparent"
          >
            <RefreshCw className="size-3.5" />
            {t("common.refresh")}
          </Button>
          {hasCompleted && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearCompleted}
              disabled={clearCompleted.isPending}
              className="h-8 gap-1.5 rounded-[8px] border-white/10 bg-transparent px-3 text-xs font-normal shadow-none hover:bg-white/[0.04] dark:bg-transparent"
            >
              <Trash2 className="size-3.5" />
              {t("tasks.clearCompleted")}
            </Button>
          )}
        </div>
      </div>

      {/* Task list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <TaskListSkeleton label={t("common.loading")} />
        ) : tasks.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.03]">
              <ListChecks className="size-5 text-muted-foreground/50" />
            </div>
            <p className="text-sm text-muted-foreground">{t("tasks.noTasks")}</p>
          </div>
        ) : (
          <div className="space-y-5">
            {tasks.map((task, idx) => (
              <TaskRow
                key={`${task.task_type}-${task.project}-${task.episode}-${idx}`}
                task={task}
                onCancel={() => handleCancel(task)}
                onDelete={() => handleDelete(task)}
                cancelling={cancelTask.isPending}
                deleting={deleteTask.isPending}
                outOfProject={false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_app/projects/$project/tasks")({
  component: TasksPage,
});
