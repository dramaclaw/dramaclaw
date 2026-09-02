// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ListTodo,
  LoaderCircle,
  LocateFixed,
  Play,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  listFreezoneWorkflowRuns,
  updateFreezoneWorkflowRun,
  type FreezoneWorkflowRun,
  type FreezoneWorkflowRunAction,
} from "@/api/canvas";
import {
  WORKFLOW_RUN_UPDATED_EVENT,
  type WorkflowRunUpdatedDetail,
} from "@/features/canvas/application/workflowExecutionActivity";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";
import {
  applyCanvasChatCommandsAsync,
  CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
  hasCurrentWorkflowResult,
} from "@/features/freezone/canvasChatCommands";
import {
  taskBatchId,
  taskBatchSize,
} from "@/features/superchat/task-notification-batch";
import { recoverableWorkflowNodeIds } from "@/features/freezone/WorkflowRunRecoveryBar";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/components/confirm-dialog-host";
import { useCancelTask } from "@/lib/queries/tasks";
import { useAppStore } from "@/stores/app-store";
import { useCanvasStore } from "@/stores/canvasStore";
import { displayLabel, isActive, isTerminal } from "@/task-center/derivations";
import { useTaskCenterStore } from "@/task-center/store";
import type { TaskState, TaskStatus } from "@/task-center/types";

const RECENT_COMPLETED_MS = 5_000;
const RECENT_FAILED_MS = 60_000;
const WORKFLOW_RUN_ACTIVE_POLL_MS = 5_000;
const WORKFLOW_RUN_IDLE_POLL_MS = 60_000;
const TERMINAL_ACTION_STATUSES = new Set([
  "completed",
  "failed",
  "blocked",
  "skipped",
]);

export interface ChatTaskItem {
  task: TaskState;
  nodeId: string | null;
  nodeLabel: string | null;
}

export interface ChatTaskBatchWaitingItem {
  batchId: string;
  expected: number;
  waiting: number;
  representative: ChatTaskItem;
}

function aggregateChatTaskBatch(items: ChatTaskItem[]): ChatTaskItem {
  const expected = Math.max(...items.map(({ task }) => taskBatchSize(task)));
  const representative = items[0];
  const active = items.filter(({ task }) => isActive(task));
  const completed = items.filter(({ task }) => task.status === "completed").length;
  const failed = items.filter(({ task }) => task.status === "failed").length;
  const cancelled = items.filter(({ task }) => task.status === "cancelled").length;
  const settled = completed + failed + cancelled;
  const waiting = Math.max(expected - items.length, 0);
  let status: TaskStatus;
  if (active.some(({ task }) => task.status === "running")) status = "running";
  else if (active.length > 0 || items.length < expected) status = "queued";
  else if (failed > 0) status = "failed";
  else if (cancelled > 0) status = "cancelled";
  else status = "completed";

  const progress = Math.min(
    1,
    items.reduce(
      (sum, { task }) => sum + (task.status === "completed" ? 1 : task.progress || 0),
      0,
    ) / expected,
  );
  return {
    ...representative,
    task: {
      ...representative.task,
      status,
      progress,
      current_task: [
        `批次进度 ${settled}/${expected}`,
        active.length > 0 ? `运行 ${active.length}` : "",
        waiting > 0 ? `等待 ${waiting}` : "",
      ].filter(Boolean).join(" · "),
      error: failed > 0 ? `${failed}/${expected} 个任务失败` : representative.task.error,
    },
  };
}

export function aggregateChatTaskBatchItems(items: ChatTaskItem[]): ChatTaskItem[] {
  const standalone: ChatTaskItem[] = [];
  const batches = new Map<string, ChatTaskItem[]>();
  for (const item of items) {
    const batchId = taskBatchId(item.task);
    if (!batchId || taskBatchSize(item.task) <= 1) {
      standalone.push(item);
      continue;
    }
    const batch = batches.get(batchId) ?? [];
    batch.push(item);
    batches.set(batchId, batch);
  }
  return [
    ...standalone,
    ...[...batches.values()].map(aggregateChatTaskBatch),
  ].sort((left, right) => {
    const activeDelta = Number(isActive(right.task)) - Number(isActive(left.task));
    if (activeDelta) return activeDelta;
    return Date.parse(right.task.updated_at) - Date.parse(left.task.updated_at);
  });
}

export function chatTaskBatchStatusSummary(items: ChatTaskItem[]): string | null {
  const activeBatch = items.find(({ task }) =>
    isActive(task) && taskBatchSize(task) > 1
  );
  const summary = activeBatch?.task.current_task?.trim();
  return summary || null;
}

export function chatTaskBatchWaitingItems(
  items: ChatTaskItem[],
): ChatTaskBatchWaitingItem[] {
  const batches = new Map<string, ChatTaskItem[]>();
  for (const item of items) {
    const batchId = taskBatchId(item.task);
    if (!batchId || taskBatchSize(item.task) <= 1) continue;
    const batch = batches.get(batchId) ?? [];
    batch.push(item);
    batches.set(batchId, batch);
  }

  return [...batches.entries()].flatMap(([batchId, batch]) => {
    const expected = Math.max(...batch.map(({ task }) => taskBatchSize(task)));
    const waiting = Math.max(expected - batch.length, 0);
    if (waiting === 0 || !isActive(aggregateChatTaskBatch(batch).task)) return [];
    return [{
      batchId,
      expected,
      waiting,
      representative: batch[0],
    }];
  });
}

export type ChatTaskStatusScope = "canvas" | "project";

function timestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function terminalTimestamp(task: TaskState): number {
  return timestamp(task.completed_at || task.updated_at);
}

export function selectChatWorkflowRun(
  runs: readonly FreezoneWorkflowRun[],
  now = Date.now(),
): FreezoneWorkflowRun | null {
  return [...runs]
    .filter((run) =>
      run.status === "running" ||
      (
        run.resumable &&
        (run.status === "failed" || run.status === "interrupted")
      ) ||
      now - timestamp(run.completed_at || run.updated_at) <= (
        run.status === "completed" ? RECENT_COMPLETED_MS : RECENT_FAILED_MS
      )
    )
    .sort((left, right) => {
      const priority = (run: FreezoneWorkflowRun) =>
        run.status === "running"
          ? 2
          : run.resumable && (run.status === "failed" || run.status === "interrupted")
            ? 1
            : 0;
      const activeDelta = priority(right) - priority(left);
      return activeDelta || timestamp(right.updated_at) - timestamp(left.updated_at);
    })[0] ?? null;
}

export function workflowRunStatusPollMs(
  runs: readonly FreezoneWorkflowRun[],
): number {
  return runs.some((run) => run.status === "running")
    ? WORKFLOW_RUN_ACTIVE_POLL_MS
    : WORKFLOW_RUN_IDLE_POLL_MS;
}

export function isStatusBarWorkflowContinuable(
  run: FreezoneWorkflowRun | null,
): boolean {
  return Boolean(
    run?.resumable &&
    (run.status === "failed" || run.status === "interrupted"),
  );
}

export function resolveWorkflowRunDisplayCompletion(
  run: FreezoneWorkflowRun | null,
  hasCurrentResult: (nodeId: string, action: string) => boolean,
  now = new Date().toISOString(),
): FreezoneWorkflowRun | null {
  if (!run || run.status === "completed") return run;
  const allReady = run.actions.length > 0 && run.actions.every(
    (action) =>
      action.status === "completed" ||
      hasCurrentResult(action.node_id, action.action),
  );
  if (!allReady) return run;
  return {
    ...run,
    status: "completed",
    resumable: false,
    completed_at: now,
    actions: run.actions.map((action) =>
      action.status === "completed"
        ? action
        : { ...action, status: "completed", updated_at: now }
    ),
  };
}

export function applyOptimisticWorkflowRunUpdate(
  run: FreezoneWorkflowRun,
  detail: WorkflowRunUpdatedDetail,
  now = new Date().toISOString(),
): FreezoneWorkflowRun {
  if (run.run_id !== detail.runId) return run;
  const updates = new Map(
    (detail.actionUpdates ?? []).map((update) => [
      `${update.node_id}:${update.action}`,
      update,
    ]),
  );
  const status = detail.status ?? run.status;
  return {
    ...run,
    status,
    resumable:
      status === "completed" || status === "cancelled"
        ? false
        : status === "failed" || status === "interrupted"
          ? true
          : run.resumable,
    ...(detail.status && status !== "running" ? { completed_at: now } : {}),
    actions: run.actions.map((action) => {
      const update = updates.get(`${action.node_id}:${action.action}`);
      return update ? { ...action, ...update, updated_at: now } : action;
    }),
  };
}

export function mergeWorkflowRunUpdate(
  previous: FreezoneWorkflowRun,
  incoming: FreezoneWorkflowRun,
): FreezoneWorkflowRun {
  const previousActions = new Map(
    previous.actions.map((action) => [`${action.node_id}:${action.action}`, action]),
  );
  const actions = incoming.actions.map((action) => {
    const prior = previousActions.get(`${action.node_id}:${action.action}`);
    return prior &&
      TERMINAL_ACTION_STATUSES.has(prior.status) &&
      !TERMINAL_ACTION_STATUSES.has(action.status)
      ? { ...action, ...prior }
      : action;
  });
  const preserveTerminalRun =
    previous.status !== "running" && incoming.status === "running";
  return {
    ...incoming,
    ...(preserveTerminalRun
      ? {
          status: previous.status,
          resumable: previous.resumable,
          completed_at: previous.completed_at,
        }
      : {}),
    actions,
  };
}

export function workflowStatusCounts(
  actions: readonly FreezoneWorkflowRunAction[],
  tasksByKey: ReadonlyMap<string, TaskState> = new Map(),
) {
  return actions.reduce(
    (counts, action) => {
      if (action.status === "completed") counts.completed += 1;
      else if (action.status === "failed" || action.status === "blocked") {
        counts.failed += 1;
      } else if (action.status === "skipped") {
        counts.skipped += 1;
      } else {
        const task = action.task_key ? tasksByKey.get(action.task_key) : undefined;
        if (task && isActive(task)) {
          if (task.status === "running") counts.inProgress += 1;
          else counts.waiting += 1;
          return counts;
        }
        if (
          action.status === "pending" ||
          isWaitingWorkflowAction(action)
        ) {
          counts.waiting += 1;
        } else if (action.status === "running") {
          counts.inProgress += 1;
        }
      }
      return counts;
    },
    { completed: 0, skipped: 0, inProgress: 0, waiting: 0, failed: 0 },
  );
}

export function workflowSettledCount(
  actions: readonly FreezoneWorkflowRunAction[],
): number {
  return actions.filter(
    (action) => action.status === "completed" || action.status === "skipped",
  ).length;
}

function isWaitingWorkflowAction(action: FreezoneWorkflowRunAction): boolean {
  return [
    "waiting_dependencies",
    "waiting_slot",
    "waiting_capacity",
  ].includes(action.phase ?? "waiting_dependencies");
}

export function selectWorkflowActivityLabels(
  actions: readonly FreezoneWorkflowRunAction[],
  nodes: readonly CanvasNode[],
  formatLabel: (
    nodeLabel: string,
    phase: FreezoneWorkflowRunAction["phase"],
  ) => string = (nodeLabel) => nodeLabel,
  tasksByKey: ReadonlyMap<string, TaskState> = new Map(),
): string[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return [...new Set(
    actions.flatMap((action) => {
      const task = action.task_key ? tasksByKey.get(action.task_key) : undefined;
      const taskIsRunning = task?.status === "running";
      if (
        !taskIsRunning &&
        (action.status !== "running" || isWaitingWorkflowAction(action))
      ) return [];
      const node = nodesById.get(action.node_id);
      if (!node?.type) return [];
      return [formatLabel(resolveNodeDisplayName(node.type, node.data), action.phase)];
    }),
  )];
}

export function selectChatTaskItems(
  tasks: Iterable<TaskState>,
  nodes: readonly CanvasNode[],
  canvasId: string | null,
  now = Date.now(),
  scope: ChatTaskStatusScope = "canvas",
): ChatTaskItem[] {
  if (scope === "canvas" && !canvasId) return [];

  const taskList = [...tasks];
  const activeBatchIds = new Set(
    taskList
      .filter(isActive)
      .map(taskBatchId)
      .filter(Boolean),
  );
  const terminalBatchWindows = new Map<string, { latest: number; failed: boolean }>();
  for (const task of taskList) {
    const batchId = taskBatchId(task);
    if (!batchId || !isTerminal(task)) continue;
    const existing = terminalBatchWindows.get(batchId) ?? { latest: 0, failed: false };
    terminalBatchWindows.set(batchId, {
      latest: Math.max(existing.latest, terminalTimestamp(task)),
      failed: existing.failed || task.status === "failed",
    });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodesByTaskKey = new Map<string, CanvasNode>();
  for (const node of nodes) {
    const key = nonEmptyString(
      (node.data as { generationTaskKey?: unknown }).generationTaskKey,
    );
    if (key) nodesByTaskKey.set(key, node);
  }

  const items: ChatTaskItem[] = [];
  for (const task of taskList) {
    const metadata = task.metadata ?? {};
    const mappedNode = nodesByTaskKey.get(task.task_key) ?? null;
    const metadataCanvasId = nonEmptyString(metadata.canvas_id);
    const metadataNodeId =
      nonEmptyString(metadata.skill_node_id) ?? nonEmptyString(metadata.node_id);
    const belongsToCanvas =
      Boolean(mappedNode) ||
      metadataCanvasId === canvasId ||
      Boolean(metadataNodeId && nodeIds.has(metadataNodeId));
    if (scope === "canvas" && !belongsToCanvas) continue;

    const batchId = taskBatchId(task);
    const batchWindow = batchId ? terminalBatchWindows.get(batchId) : undefined;
    const batchVisible = Boolean(
      batchId && (
        activeBatchIds.has(batchId) ||
        (
          batchWindow &&
          now - batchWindow.latest <= (
            batchWindow.failed ? RECENT_FAILED_MS : RECENT_COMPLETED_MS
          )
        )
      ),
    );
    const visible =
      isActive(task) ||
      batchVisible ||
      (
        isTerminal(task) &&
        now - terminalTimestamp(task) <= (
          task.status === "completed" ? RECENT_COMPLETED_MS : RECENT_FAILED_MS
        )
      );
    if (!visible) continue;

    const node = scope === "canvas"
      ? mappedNode ?? nodes.find((candidate) => candidate.id === metadataNodeId) ?? null
      : null;
    items.push({
      task,
      nodeId: node?.id ?? null,
      nodeLabel:
        node && node.type
          ? resolveNodeDisplayName(node.type, node.data)
          : null,
    });
  }

  const sorted = items.sort((left, right) => {
    const activeDelta = Number(isActive(right.task)) - Number(isActive(left.task));
    if (activeDelta) return activeDelta;
    return Date.parse(right.task.updated_at) - Date.parse(left.task.updated_at);
  });
  return sorted;
}

function taskProgress(task: TaskState): number {
  if (task.status === "completed") return 100;
  return Math.max(0, Math.min(100, Math.round((task.progress || 0) * 100)));
}

export function ChatTaskStatusBar({
  projectId,
  canvasId,
  scope = "canvas",
}: {
  projectId: string | null;
  canvasId: string | null;
  scope?: ChatTaskStatusScope;
}) {
  const { t } = useTranslation();
  const tasks = useTaskCenterStore((state) => state.tasks);
  const taskProjectId = useTaskCenterStore((state) => state.projectId);
  const nodes = useCanvasStore((state) => state.nodes);
  const setTaskPanelOpen = useAppStore((state) => state.setTaskPanelOpen);
  const setSelectedTask = useTaskCenterStore((state) => state.setSelected);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [workflowRuns, setWorkflowRuns] = useState<FreezoneWorkflowRun[]>([]);
  const [resuming, setResuming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancelTask = useCancelTask();

  const taskItems = useMemo(
    () => {
      const projectScopeUnavailable =
        scope === "project" &&
        (!projectId || Boolean(taskProjectId && taskProjectId !== projectId));
      return selectChatTaskItems(
        projectScopeUnavailable ? [] : tasks.values(),
        scope === "canvas" ? nodes : [],
        canvasId,
        now,
        scope,
      );
    },
    [tasks, taskProjectId, nodes, canvasId, now, projectId, scope],
  );
  const items = useMemo(
    () => aggregateChatTaskBatchItems(taskItems),
    [taskItems],
  );
  const selectedWorkflowRun = useMemo(
    () => selectChatWorkflowRun(workflowRuns, now),
    [now, workflowRuns],
  );
  const resolvedWorkflowRun = useMemo(
    () => resolveWorkflowRunDisplayCompletion(
      selectedWorkflowRun,
      hasCurrentWorkflowResult,
    ),
    [nodes, selectedWorkflowRun],
  );
  const workflowRun =
    resolvedWorkflowRun?.status === "completed" &&
    now - timestamp(resolvedWorkflowRun.completed_at || resolvedWorkflowRun.updated_at) >
      RECENT_COMPLETED_MS
      ? null
      : resolvedWorkflowRun;
  const existingNodeIds = useMemo(
    () => new Set(nodes.map((node) => node.id)),
    [nodes],
  );
  const resumeNodeIds = useMemo(
    () =>
      workflowRun && isStatusBarWorkflowContinuable(workflowRun)
        ? recoverableWorkflowNodeIds(workflowRun, existingNodeIds)
        : [],
    [existingNodeIds, workflowRun],
  );
  const workflowTasksByKey = useMemo(() => {
    const linked = new Map<string, TaskState>();
    for (const action of workflowRun?.actions ?? []) {
      if (!action.task_key) continue;
      const task = tasks.get(action.task_key);
      if (task) linked.set(action.task_key, task);
    }
    return linked;
  }, [tasks, workflowRun]);
  const workflowActivityLabels = useMemo(
    () => selectWorkflowActivityLabels(
      workflowRun?.actions ?? [],
      nodes,
      (nodeLabel, phase) => t(
        `taskCenter.chatStatus.workflowActivity.${phase ?? "preparing"}`,
        { name: nodeLabel },
      ),
      workflowTasksByKey,
    ),
    [nodes, t, workflowRun, workflowTasksByKey],
  );
  const workflowActivityLabelsKey = workflowActivityLabels.join("\u0000");
  const [workflowActivityIndex, setWorkflowActivityIndex] = useState(0);
  const hasTerminalItems =
    taskItems.some(({ task }) => isTerminal(task)) ||
    Boolean(workflowRun && workflowRun.status !== "running");

  const refreshWorkflowRuns = useCallback(async () => {
    if (scope !== "canvas" || !projectId || !canvasId) {
      setWorkflowRuns([]);
      return;
    }
    try {
      const response = await listFreezoneWorkflowRuns(projectId, canvasId);
      setWorkflowRuns(response.runs);
    } catch {
      // Generation tasks remain visible even if optional workflow status is unavailable.
    }
  }, [canvasId, projectId, scope]);

  useEffect(() => {
    setWorkflowRuns([]);
    void refreshWorkflowRuns();
  }, [refreshWorkflowRuns]);

  useEffect(() => {
    if (scope !== "canvas") return;
    const handleRunUpdate = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowRunUpdatedDetail>).detail;
      if (detail?.projectId && detail.projectId !== projectId) return;
      if (detail?.canvasId && detail.canvasId !== canvasId) return;
      if (detail?.run) {
        setWorkflowRuns((current) => {
          const previous = current.find((run) => run.run_id === detail.run!.run_id);
          if (previous && timestamp(previous.updated_at) > timestamp(detail.run!.updated_at)) {
            return current;
          }
          const nextRun = previous
            ? mergeWorkflowRunUpdate(previous, detail.run!)
            : detail.run!;
          return [
            nextRun,
            ...current.filter((run) => run.run_id !== detail.run!.run_id),
          ];
        });
        return;
      }
      if (detail?.actionUpdates?.length || detail?.status) {
        setWorkflowRuns((current) =>
          current.map((run) => applyOptimisticWorkflowRunUpdate(run, detail)));
        return;
      }
      void refreshWorkflowRuns();
    };
    window.addEventListener(WORKFLOW_RUN_UPDATED_EVENT, handleRunUpdate);
    return () => {
      window.removeEventListener(WORKFLOW_RUN_UPDATED_EVENT, handleRunUpdate);
    };
  }, [canvasId, projectId, refreshWorkflowRuns, scope]);

  useEffect(() => {
    if (!projectId || !canvasId) return;
    const timer = window.setInterval(
      () => void refreshWorkflowRuns(),
      workflowRunStatusPollMs(workflowRuns),
    );
    return () => window.clearInterval(timer);
  }, [canvasId, projectId, refreshWorkflowRuns, workflowRuns]);

  useEffect(() => {
    if (!hasTerminalItems) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasTerminalItems]);

  useEffect(() => {
    if (items.length === 0 && !workflowRun) setExpanded(false);
  }, [items.length, workflowRun]);

  useEffect(() => {
    setWorkflowActivityIndex(0);
    if (workflowActivityLabels.length <= 1) return;
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduceMotion) return;
    const timer = window.setInterval(() => {
      setWorkflowActivityIndex((index) => (index + 1) % workflowActivityLabels.length);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [workflowActivityLabels.length, workflowActivityLabelsKey]);

  if (items.length === 0 && !workflowRun) return null;

  const activeItems = items.filter(({ task }) => isActive(task));
  const runningCount = activeItems.filter(({ task }) => task.status === "running").length;
  const waitingCount = activeItems.length - runningCount;
  const failedCount = items.filter(({ task }) => task.status === "failed").length;
  const completedCount = items.filter(({ task }) => task.status === "completed").length;
  const leading = activeItems[0] ?? items[0] ?? null;
  const batchStatusSummary = chatTaskBatchStatusSummary(items);
  const workflowActions = workflowRun?.actions ?? [];
  const workflowCounts = workflowStatusCounts(workflowActions, workflowTasksByKey);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const workflowNodeLabel = (action: FreezoneWorkflowRunAction | null): string | null => {
    if (!action) return null;
    const node = nodeById.get(action.node_id);
    return node?.type ? resolveNodeDisplayName(node.type, node.data) : null;
  };
  const workflowActionLabel = (action: FreezoneWorkflowRunAction): string => {
    if (action.status === "completed") return t("taskCenter.chatStatus.workflowPhase.completed");
    if (action.status === "failed") return t("taskCenter.chatStatus.workflowPhase.failed");
    if (action.status === "blocked") return t("taskCenter.chatStatus.workflowPhase.blocked");
    if (action.status === "skipped") return t("taskCenter.chatStatus.workflowPhase.skipped");
    return t(`taskCenter.chatStatus.workflowPhase.${action.phase ?? "waiting_dependencies"}`);
  };
  const summary = workflowRun
    ? workflowRun.status === "completed"
      ? t("taskCenter.chatStatus.workflowCompletedShort", {
          completed: workflowSettledCount(workflowActions),
          total: workflowActions.length,
        })
      : [
          t("taskCenter.chatStatus.workflowShort", {
            completed: workflowCounts.completed,
            total: workflowActions.length,
          }),
          workflowRun.status === "interrupted"
            ? t("taskCenter.chatStatus.interruptedShort")
            : workflowRun.status === "failed"
              ? t("taskCenter.chatStatus.stoppedShort")
              : null,
          workflowCounts.inProgress > 0
            && workflowRun.status === "running"
            ? t("taskCenter.chatStatus.inProgressShort", {
                count: workflowCounts.inProgress,
              })
            : null,
          workflowCounts.waiting > 0
            && workflowRun.status === "running"
            ? t("taskCenter.chatStatus.waitingShort", {
                count: workflowCounts.waiting,
              })
            : null,
          workflowCounts.failed > 0
            ? t("taskCenter.chatStatus.failedShort", {
                count: workflowCounts.failed,
              })
            : null,
        ].filter(Boolean).join(" · ")
    : batchStatusSummary
      ? batchStatusSummary
      : activeItems.length
      ? [
          runningCount
            ? t("taskCenter.chatStatus.running", { count: runningCount })
            : null,
          waitingCount
            ? t("taskCenter.chatStatus.waiting", { count: waitingCount })
            : null,
        ].filter(Boolean).join(" · ")
      : failedCount
        ? t("taskCenter.chatStatus.failed", { count: failedCount })
        : t("taskCenter.chatStatus.completed", { count: completedCount });
  const leadingLabel = workflowRun
    ? workflowActivityLabels[
        workflowActivityIndex % Math.max(workflowActivityLabels.length, 1)
      ] ?? ""
    : leading
      ? leading.nodeLabel ?? displayLabel(leading.task, t)
      : "";

  const openTask = (taskKey: string) => {
    setSelectedTask(taskKey);
    setTaskPanelOpen(true);
  };
  const openTaskCenter = () => {
    if (leading) setSelectedTask(leading.task.task_key);
    setTaskPanelOpen(true);
  };
  const activeStandaloneTasks = taskItems
    .map(({ task }) => task)
    .filter((task) =>
      isActive(task) &&
      !workflowRun?.actions.some((action) => action.task_key === task.task_key),
    );
  const cancelOneTask = async (task: TaskState) => {
    const confirmed = await confirmDialog({
      title: "取消生成任务",
      description: `确定取消“${displayLabel(task, t)}”吗？运行中的任务取消后通常不退款。`,
      confirmText: "确认取消",
      cancelText: "继续生成",
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setCancelling(true);
    try {
      await cancelTask.mutateAsync({
        type: task.task_type,
        project: projectId ?? task.project_id ?? task.project,
        episode: task.episode,
        beatNum: task.beat_num ?? undefined,
        scope: task.scope ?? undefined,
        confirmed: true,
      });
      toast.success("任务已提交取消");
    } catch (error) {
      toast.error(`取消任务失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCancelling(false);
    }
  };
  const cancelAll = async () => {
    const workflowActive = workflowRun?.status === "running";
    const count = activeStandaloneTasks.length + (workflowActive ? 1 : 0);
    if (count === 0 || cancelling) return;
    const confirmed = await confirmDialog({
      title: "全部取消生成任务",
      description: `确定取消当前列表中的 ${count} 项任务吗？运行中的任务取消后通常不退款，已完成的任务不会回滚。`,
      confirmText: "确认全部取消",
      cancelText: "继续生成",
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setCancelling(true);
    try {
      if (workflowActive && projectId && canvasId && workflowRun) {
        await updateFreezoneWorkflowRun(projectId, canvasId, workflowRun.run_id, {
          status: "cancelled",
        });
      }
      const results = await Promise.allSettled(
        activeStandaloneTasks.map((task) => cancelTask.mutateAsync({
          type: task.task_type,
          project: projectId ?? task.project_id ?? task.project,
          episode: task.episode,
          beatNum: task.beat_num ?? undefined,
          scope: task.scope ?? undefined,
          confirmed: true,
        })),
      );
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) toast.error(`${failed} 项任务取消失败，请到任务中心查看`);
      else toast.success("已提交全部取消");
      await refreshWorkflowRuns();
    } catch (error) {
      toast.error(`取消任务失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCancelling(false);
    }
  };
  const resumeWorkflow = async () => {
    if (
      resuming ||
      !projectId ||
      !canvasId ||
      !workflowRun ||
      resumeNodeIds.length === 0
    ) {
      return;
    }
    setResuming(true);
    try {
      const result = await applyCanvasChatCommandsAsync(
        [{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          project_id: projectId,
          canvas_id: canvasId,
          commands: [{
            type: "run_workflow",
            node_ids: resumeNodeIds,
            direction: "downstream",
            regenerate: false,
          }],
        }],
        { projectId, canvasId },
      );
      if (result.errors.length > 0) {
        throw new Error(result.errors[0] ?? t("taskCenter.chatStatus.resumeFailedFallback"));
      }
      await refreshWorkflowRuns();
      toast.success(t("taskCenter.chatStatus.resumeSucceeded"));
    } catch (error) {
      toast.error(t("taskCenter.chatStatus.resumeFailed", {
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setResuming(false);
    }
  };

  const locateNode = (nodeId: string) => {
    const store = useCanvasStore.getState();
    if (!store.nodes.some((node) => node.id === nodeId)) return;
    store.onNodesChange(
      store.nodes.map((node) => ({
        id: node.id,
        type: "select" as const,
        selected: node.id === nodeId,
      })),
    );
    store.setSelectedNode(nodeId);
    store.requestFocusNode(nodeId);
  };
  const linkedWorkflowTaskKeys = new Set(
    workflowActions.map((action) => action.task_key).filter(Boolean),
  );
  const detailItems = workflowRun
    ? taskItems.filter(({ task }) => !linkedWorkflowTaskKeys.has(task.task_key))
    : taskItems;
  const waitingBatchItems = chatTaskBatchWaitingItems(detailItems);
  const hasActiveStatus = activeItems.length > 0 || workflowRun?.status === "running";
  const hasFailedStatus =
    failedCount > 0 ||
    Boolean(
      workflowRun &&
      workflowRun.status !== "running" &&
      workflowRun.status !== "completed",
    );

  return (
    <section
      className={cn(
        "mx-auto mb-2 w-full overflow-hidden rounded-lg border border-white/10 bg-background/92 shadow-sm backdrop-blur-xl",
        scope === "project" && "max-w-[760px]",
      )}
    >
      <div className="flex h-10 min-w-0 items-center gap-2 px-2.5">
        {hasActiveStatus ? (
          <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
        ) : hasFailedStatus ? (
          <AlertCircle className="size-4 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="size-4 shrink-0 text-success" />
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="shrink-0 text-xs font-medium text-foreground" aria-live="polite">
            {summary}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {leadingLabel}
          </span>
          <ChevronDown
            className={cn(
              "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        {workflowRun &&
        isStatusBarWorkflowContinuable(workflowRun) &&
        resumeNodeIds.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            disabled={resuming}
            title={t("taskCenter.chatStatus.resume")}
            onClick={() => void resumeWorkflow()}
          >
            {resuming ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            {resuming
              ? t("taskCenter.chatStatus.resuming")
              : workflowRun.status === "failed"
                ? t("taskCenter.chatStatus.continueDownstream")
                : t("taskCenter.chatStatus.resume")}
          </Button>
        ) : null}
        {hasActiveStatus ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 gap-1 px-2 text-xs text-destructive hover:text-destructive"
            disabled={cancelling}
            title="全部取消"
            onClick={() => void cancelAll()}
          >
            {cancelling ? <LoaderCircle className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
            全部取消
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          title={t("taskCenter.panel.open")}
          aria-label={t("taskCenter.panel.open")}
          onClick={openTaskCenter}
        >
          <ListTodo className="size-4" />
        </Button>
      </div>

      {expanded ? (
        <div className="max-h-52 overflow-y-auto border-t border-white/8 px-2 py-1.5">
          {workflowRun ? workflowActions.map((action) => {
            const task = action.task_key
              ? workflowTasksByKey.get(action.task_key) ?? null
              : null;
            const progress = task
              ? taskProgress(task)
              : action.status === "completed" || action.status === "skipped"
                ? 100
                : 0;
            const active = action.status === "running" || action.status === "pending";
            const label = workflowNodeLabel(action) ?? action.action;
            return (
              <div
                key={`${action.node_id}:${action.action}`}
                className="flex min-h-11 items-center gap-2 border-b border-white/6 px-1.5 py-1.5 last:border-b-0"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => task ? openTask(task.task_key) : locateNode(action.node_id)}
                >
                  <span className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-foreground">{label}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {task && isActive(task)
                        ? `${workflowActionLabel(action)} · ${progress}%`
                        : workflowActionLabel(action)}
                    </span>
                  </span>
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-white/8">
                    <span
                      className={cn(
                        "block h-full rounded-full transition-[width] duration-300",
                        action.status === "failed" || action.status === "blocked"
                          ? "bg-destructive"
                          : action.status === "completed" || action.status === "skipped"
                            ? "bg-success"
                            : "bg-primary",
                        active && progress === 0 && "animate-pulse",
                      )}
                      style={{ width: active && progress === 0 ? "32%" : `${progress}%` }}
                    />
                  </span>
                </button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  title={t("taskCenter.chatStatus.locateNode")}
                  aria-label={t("taskCenter.chatStatus.locateNode")}
                  onClick={() => locateNode(action.node_id)}
                >
                  <LocateFixed className="size-3.5" />
                </Button>
                {task && isActive(task) ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0 text-destructive hover:text-destructive"
                    title="取消任务"
                    aria-label="取消任务"
                    disabled={cancelling}
                    onClick={() => void cancelOneTask(task)}
                  >
                    <X className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            );
          }) : null}
          {detailItems.map(({ task, nodeId, nodeLabel }) => {
            const progress = taskProgress(task);
            return (
              <div
                key={task.task_key}
                className="flex min-h-11 items-center gap-2 border-b border-white/6 px-1.5 py-1.5 last:border-b-0"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => openTask(task.task_key)}
                >
                  <span className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-foreground">
                      {nodeLabel ?? displayLabel(task, t)}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {t(`taskCenter.status.${task.status}`)}
                      {isActive(task) ? ` · ${progress}%` : ""}
                    </span>
                  </span>
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-white/8">
                    <span
                      className={cn(
                        "block h-full rounded-full transition-[width] duration-300",
                        task.status === "failed"
                          ? "bg-destructive"
                          : task.status === "completed"
                            ? "bg-success"
                            : "bg-primary",
                      )}
                      style={{ width: `${progress}%` }}
                    />
                  </span>
                </button>
                {nodeId ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    title={t("taskCenter.chatStatus.locateNode")}
                    aria-label={t("taskCenter.chatStatus.locateNode")}
                    onClick={() => locateNode(nodeId)}
                  >
                    <LocateFixed className="size-3.5" />
                  </Button>
                ) : null}
                {isActive(task) ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0 text-destructive hover:text-destructive"
                    title="取消任务"
                    aria-label="取消任务"
                    disabled={cancelling}
                    onClick={() => void cancelOneTask(task)}
                  >
                    <X className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            );
          })}
          {waitingBatchItems.map(({ batchId, waiting, representative }) => (
            <div
              key={`${batchId}:waiting`}
              className="flex min-h-11 items-center gap-2 border-b border-white/6 px-1.5 py-1.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-foreground">
                    {representative.nodeLabel ?? displayLabel(representative.task, t)}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {t("taskCenter.chatStatus.waiting", { count: waiting })}
                  </span>
                </span>
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-white/8">
                  <span className="block h-full w-0 rounded-full bg-muted-foreground/35" />
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
