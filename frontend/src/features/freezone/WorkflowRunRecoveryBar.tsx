import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle, Pencil, RotateCcw, SkipForward, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  listFreezoneWorkflowRuns,
  updateFreezoneWorkflowRun,
  type FreezoneWorkflowRun,
} from "@/api/canvas";
import { Button } from "@/components/ui/button";
import type { WorkflowRunUpdatedDetail } from "@/features/canvas/application/workflowExecutionActivity";
import {
  applyCanvasChatCommandsAsync,
  CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
  FREEZONE_WORKFLOW_RUN_UPDATED_EVENT,
  hasGeneratedResult,
  isNodeActionGenerationPending,
} from "@/features/freezone/canvasChatCommands";
import { useCanvasStore } from "@/stores/canvasStore";
import { useTaskCenterStore } from "@/task-center/store";

const RESUMABLE_ACTION_STATUSES = new Set(["pending", "running", "failed", "blocked"]);

function isSafetyReviewError(error: string | null | undefined): boolean {
  const normalized = String(error || "").toLowerCase();
  return normalized.includes("safety review")
    || normalized.includes("内容未通过安全审核") // i18n-exempt -- backend error matching
    || normalized.includes("内容安全审核") // i18n-exempt -- backend error matching
    || normalized.includes("sensitivecontent")
    || normalized.includes("privacyinformation")
    || normalized.includes("moderation_blocked");
}

export function resumableWorkflowNodeIds(run: FreezoneWorkflowRun): string[] {
  return [...new Set(
    run.actions
      .filter((action) => RESUMABLE_ACTION_STATUSES.has(action.status))
      .map((action) => action.node_id)
      .filter(Boolean),
  )];
}

export function staleResumableWorkflowRunIds(
  runs: FreezoneWorkflowRun[],
  existingNodeIds: ReadonlySet<string>,
): string[] {
  return runs
    .filter((run) =>
      run.resumable &&
      ["running", "failed", "interrupted"].includes(run.status) &&
      resumableWorkflowNodeIds(run).length > 0 &&
      unresolvedWorkflowActions(run, existingNodeIds).length === 0
    )
    .map((run) => run.run_id);
}

function unresolvedWorkflowActions(
  run: FreezoneWorkflowRun,
  existingNodeIds: ReadonlySet<string>,
) {
  return run.actions.filter((action) =>
    RESUMABLE_ACTION_STATUSES.has(action.status) &&
    existingNodeIds.has(action.node_id) &&
    !hasGeneratedResult(action.node_id, action.action)
  );
}

function recoverableWorkflowActions(
  run: FreezoneWorkflowRun,
  existingNodeIds: ReadonlySet<string>,
) {
  return unresolvedWorkflowActions(run, existingNodeIds).filter(
    (action) => {
      // A downstream action blocked by a failed dependency was recorded for
      // visibility, but has never been submitted. Do not surface it as an
      // independent retry target or create another waiting progress item.
      if (action.status === "blocked" && String(action.error || "").startsWith("跳过 ")) { // i18n-exempt -- workflow payload
        return false;
      }
      return !isNodeActionGenerationPending(action.node_id, action.action);
    },
  );
}

export function recoverableWorkflowNodeIds(
  run: FreezoneWorkflowRun,
  existingNodeIds: ReadonlySet<string>,
): string[] {
  return [...new Set(
    recoverableWorkflowActions(run, existingNodeIds).map((action) => action.node_id),
  )];
}

function latestResumableRun(
  runs: FreezoneWorkflowRun[],
  existingNodeIds: ReadonlySet<string>,
): FreezoneWorkflowRun | null {
  return runs.find((run) =>
    run.resumable &&
    ["failed", "interrupted"].includes(run.status) &&
    recoverableWorkflowActions(run, existingNodeIds).length > 0
  ) ?? null;
}

export function WorkflowRunRecoveryBar({
  projectId,
  canvasId,
}: {
  projectId: string;
  canvasId: string;
}) {
  const { t } = useTranslation();
  const canvasNodes = useCanvasStore((state) => state.nodes);
  const existingNodeIds = useMemo(
    () => new Set(canvasNodes.map((node) => node.id)),
    [canvasNodes],
  );
  const [runs, setRuns] = useState<FreezoneWorkflowRun[]>([]);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const staleCleanupRef = useRef(new Set<string>());
  const trackedTaskKeys = useMemo(
    () => new Set(
      runs.flatMap((item) =>
        item.actions
          .map((action) => action.task_key?.trim() ?? "")
          .filter(Boolean)
      ),
    ),
    [runs],
  );

  const refresh = useCallback(async () => {
    try {
      const response = await listFreezoneWorkflowRuns(projectId, canvasId);
      setRuns(response.runs);
    } catch {
      // Recovery is optional and must not add an error state to the canvas itself.
      setRuns([]);
    }
  }, [canvasId, projectId]);

  useEffect(() => {
    setDismissedRunId(null);
    setError(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const staleRunIds = staleResumableWorkflowRunIds(runs, existingNodeIds)
      .filter((runId) => !staleCleanupRef.current.has(runId));
    if (staleRunIds.length === 0) return;
    for (const runId of staleRunIds) staleCleanupRef.current.add(runId);
    void Promise.all(staleRunIds.map(async (runId) => {
      try {
        await updateFreezoneWorkflowRun(projectId, canvasId, runId, { status: "cancelled" });
        setRuns((current) => current.map((item) =>
          item.run_id === runId ? { ...item, status: "cancelled", resumable: false } : item
        ));
      } catch {
        staleCleanupRef.current.delete(runId);
      }
    }));
  }, [canvasId, existingNodeIds, projectId, runs]);

  useEffect(() => {
    const handleRunUpdated = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowRunUpdatedDetail>).detail;
      if (detail?.projectId && detail.projectId !== projectId) return;
      if (detail?.canvasId && detail.canvasId !== canvasId) return;
      if (detail?.run) {
        setRuns((current) => [
          detail.run!,
          ...current.filter((item) => item.run_id !== detail.run!.run_id),
        ]);
        return;
      }
      void refresh();
    };
    window.addEventListener(FREEZONE_WORKFLOW_RUN_UPDATED_EVENT, handleRunUpdated);
    const refreshInterval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      window.removeEventListener(FREEZONE_WORKFLOW_RUN_UPDATED_EVENT, handleRunUpdated);
      window.clearInterval(refreshInterval);
    };
  }, [canvasId, projectId, refresh]);

  useEffect(() => {
    if (trackedTaskKeys.size === 0) return;
    return useTaskCenterStore.subscribe((state, previous) => {
      if (state.tasks === previous.tasks) return;
      for (const taskKey of trackedTaskKeys) {
        if (state.tasks.get(taskKey) === previous.tasks.get(taskKey)) continue;
        void refresh();
        return;
      }
    });
  }, [refresh, trackedTaskKeys]);

  const run = useMemo(
    () => latestResumableRun(runs, existingNodeIds),
    [existingNodeIds, runs],
  );
  const nodeIds = useMemo(
    () => run
      ? recoverableWorkflowNodeIds(run, existingNodeIds)
      : [],
    [canvasNodes, existingNodeIds, run],
  );
  const failedNodeIds = useMemo(
    () => run
      ? [...new Set(
        recoverableWorkflowActions(run, existingNodeIds)
          .filter((action) =>
            action.status === "failed" &&
            existingNodeIds.has(action.node_id) &&
            !isSafetyReviewError(action.error)
          )
          .map((action) => action.node_id),
      )]
      : [],
    [canvasNodes, existingNodeIds, run],
  );
  const safetyNodeIds = useMemo(
    () => run
      ? [...new Set(
        recoverableWorkflowActions(run, existingNodeIds)
          .filter((action) =>
            action.status === "failed" &&
            existingNodeIds.has(action.node_id) &&
            isSafetyReviewError(action.error)
          )
          .map((action) => action.node_id),
      )]
      : [],
    [canvasNodes, existingNodeIds, run],
  );
  if (!run || run.run_id === dismissedRunId || nodeIds.length === 0) return null;

  const handleResume = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyCanvasChatCommandsAsync(
        [{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          project_id: projectId,
          canvas_id: canvasId,
          commands: [{
            type: "run_workflow",
            node_ids: nodeIds,
            direction: "downstream",
            regenerate: false,
          }],
        }],
        { projectId, canvasId },
      );
      if (result.errors.length > 0) {
        setError(result.errors[0] ?? "恢复执行失败");
      }
      await refresh();
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : String(resumeError));
    } finally {
      setBusy(false);
    }
  };

  const handleRetryFailed = async () => {
    if (busy || failedNodeIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyCanvasChatCommandsAsync(
        [{
          schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
          project_id: projectId,
          canvas_id: canvasId,
          commands: [{
            type: "run_workflow",
            node_ids: failedNodeIds,
            direction: "node",
            regenerate: true,
          }],
        }],
        { projectId, canvasId },
      );
      if (result.errors.length > 0) {
        setError(result.errors[0] ?? "节点重试失败");
      }
      await refresh();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
    } finally {
      setBusy(false);
    }
  };

  const handleEditSafetyPrompt = () => {
    const nodeId = safetyNodeIds[0];
    if (!nodeId) return;
    useCanvasStore.getState().setSelectedNode(nodeId);
    useCanvasStore.getState().requestFocusNode(nodeId);
    setDismissedRunId(run?.run_id ?? null);
  };

  const handleSkipSafetyNodes = async () => {
    if (busy || !run || safetyNodeIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const updates = run.actions
        .filter((action) => safetyNodeIds.includes(action.node_id) && action.status === "failed")
        .map((action) => ({
          node_id: action.node_id,
          action: action.action,
          status: "skipped" as const,
          error: "用户选择跳过安全审核失败节点", // i18n-exempt -- workflow payload
        }));
      const updated = await updateFreezoneWorkflowRun(projectId, canvasId, run.run_id, {
        action_updates: updates,
      });
      setRuns((current) => current.map((item) => item.run_id === run.run_id ? updated : item));
    } catch (skipError) {
      setError(skipError instanceof Error ? skipError.message : String(skipError));
    } finally {
      setBusy(false);
    }
  };

  const completedCount = Math.max(0, run.actions.length - nodeIds.length);
  return (
    <div className="pointer-events-auto absolute left-1/2 top-4 z-30 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3 rounded-md border border-border/70 bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
      <div className="min-w-0 text-sm">
        <div className="truncate font-medium">发现未完成的工作流</div>
        <div className="truncate text-xs text-muted-foreground">
          已完成 {completedCount}/{run.actions.length}，剩余 {nodeIds.length} 个节点
        </div>
        {error && <div className="mt-1 max-w-[420px] truncate text-xs text-destructive">{error}</div>}
      </div>
      {safetyNodeIds.length > 0 && (
        <>
          <div className="inline-flex items-center gap-1 text-xs text-amber-200">
            <AlertTriangle className="size-3.5" />
            {t("freezone.workflowRecovery.safetyReviewFailed", { defaultValue: "有节点未通过安全审核" })}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleEditSafetyPrompt} disabled={busy}>
            <Pencil className="size-4" />
            {t("freezone.workflowRecovery.editPrompt", { defaultValue: "修改提示词" })}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void handleSkipSafetyNodes()} disabled={busy}>
            <SkipForward className="size-4" />
            {t("freezone.workflowRecovery.skipNode", { defaultValue: "跳过节点" })}
          </Button>
        </>
      )}
      {failedNodeIds.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleRetryFailed()}
          disabled={busy}
        >
          <RotateCcw className="size-4" />
          仅重试失败
        </Button>
      )}
      <Button type="button" size="sm" onClick={() => void handleResume()} disabled={busy}>
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
        继续下游
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => setDismissedRunId(run.run_id)}
        aria-label="暂时忽略"
        title="暂时忽略"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
