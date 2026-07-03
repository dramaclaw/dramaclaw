// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useTaskCenterStore } from "@/task-center/store";
import { TaskLogs } from "./task-logs";
import { TaskActions } from "./task-actions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { displayLabel } from "@/task-center/derivations";
import { taskErrorMessage } from "@/task-center/task-errors";
import type { TaskState } from "@/task-center/types";

export function formatLocalTaskTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const formatted = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const minutes = String(absOffset % 60).padStart(2, "0");
  return `${formatted} UTC${sign}${hours}:${minutes}`;
}

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field.trim() : "";
}

function resultMetadata(task: TaskState): Record<string, unknown> | null {
  const result = task.result;
  if (!result || typeof result !== "object") return null;
  const metadata = (result as Record<string, unknown>).task_metadata;
  return metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : null;
}

function taskMetadata(task: TaskState): Record<string, unknown> {
  return {
    ...(resultMetadata(task) ?? {}),
    ...(task.metadata ?? {}),
  };
}

function providerTaskId(task: TaskState): string {
  const result = task.result;
  const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : null;
  const resultTaskMetadata =
    resultRecord?.task_metadata && typeof resultRecord.task_metadata === "object"
      ? resultRecord.task_metadata as Record<string, unknown>
      : null;
  const metadata = taskMetadata(task);
  return (
    stringField(result, "provider_task_id") ||
    stringField(result, "huimeng_task_id") ||
    stringField(result, "newapi_task_id") ||
    stringField(resultTaskMetadata, "provider_task_id") ||
    stringField(resultTaskMetadata, "huimeng_task_id") ||
    stringField(resultTaskMetadata, "newapi_task_id") ||
    stringField(metadata, "provider_task_id") ||
    stringField(metadata, "huimeng_task_id") ||
    stringField(metadata, "newapi_task_id")
  );
}

function metadataField(task: TaskState, key: string): string {
  return stringField(taskMetadata(task), key);
}

function debugLabel(key: string, t: ReturnType<typeof useTranslation>["t"]): string {
  if (key === "task_id") return t("taskCenter.detail.meta.taskId");
  if (key === "provider_task_id") return t("taskCenter.detail.meta.providerTaskId");
  return key;
}

function isPathLikeKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return (
    lowered === "path" ||
    lowered === "paths" ||
    lowered.endsWith("_path") ||
    lowered.endsWith("_paths")
  );
}

function isAbsoluteLocalPath(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  if (
    lowered.startsWith("/static/") ||
    lowered.startsWith("http://") ||
    lowered.startsWith("https://") ||
    lowered.startsWith("blob:") ||
    lowered.startsWith("data:")
  ) {
    return false;
  }
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function sanitizeResultForDisplay(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    if (
      isPathLikeKey(key) &&
      value.some((item) => typeof item === "string" && isAbsoluteLocalPath(item))
    ) {
      return undefined;
    }
    return value
      .map((item) => sanitizeResultForDisplay(item))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([entryKey, entryValue]) => {
      const sanitized = sanitizeResultForDisplay(entryValue, entryKey);
      if (sanitized !== undefined) out[entryKey] = sanitized;
    });
    return out;
  }
  if (typeof value === "string" && isPathLikeKey(key) && isAbsoluteLocalPath(value)) {
    return undefined;
  }
  return value;
}

export function TaskDetail() {
  const { t } = useTranslation();
  const selectedTaskKey = useTaskCenterStore((s) => s.selectedTaskKey);
  const tasksMap = useTaskCenterStore((s) => s.tasks);
  const task = useMemo(
    () => (selectedTaskKey ? tasksMap.get(selectedTaskKey) ?? null : null),
    [selectedTaskKey, tasksMap],
  );

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("taskCenter.panel.selectPrompt")}
      </div>
    );
  }
  const providerId = providerTaskId(task);
  const displayResult = task.result ? sanitizeResultForDisplay(task.result) : null;
  const sourceLabel = metadataField(task, "source_label");
  const targetLabel = metadataField(task, "target_label");
  const jobId = metadataField(task, "job_id") || metadataField(task, "scope") || task.scope || "";
  const celeryId = metadataField(task, "celery_task_id");
  const skillId = metadataField(task, "skill_id");
  const canvasId = metadataField(task, "canvas_id");
  const nodeId = metadataField(task, "node_id");
  const debugRows = [
    ["task_key", task.task_key],
    ["task_id", task.task_id],
    ["job_id", jobId],
    ["celery_task_id", celeryId],
    ["provider_task_id", providerId],
    ["skill_id", skillId],
    ["canvas_id", canvasId],
    ["node_id", nodeId],
  ].filter(([, value]) => Boolean(value));

  return (
    <div className="flex h-full flex-col">
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="px-3 pt-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold">{displayLabel(task, t)}</h3>
            <Badge>{t(`taskCenter.status.${task.status}`)}</Badge>
          </div>
          {(sourceLabel || targetLabel) ? (
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              {[sourceLabel, targetLabel].filter(Boolean).join(" → ")}
            </div>
          ) : null}
        </div>
        <TabsList className="mx-3 mt-2 shrink-0 self-start">
          <TabsTrigger value="overview">{t("taskCenter.detail.tabs.overview")}</TabsTrigger>
          <TabsTrigger value="logs">{t("taskCenter.detail.tabs.logs")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto p-3 text-xs">
          <div className="grid grid-cols-3 gap-x-3 gap-y-1">
            <div>
              <div className="text-muted-foreground">
                {t("taskCenter.detail.meta.createdAt")}
              </div>
              <div className="font-mono text-[11px]">{formatLocalTaskTime(task.created_at)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">
                {t("taskCenter.detail.meta.updatedAt")}
              </div>
              <div className="font-mono text-[11px]">{formatLocalTaskTime(task.updated_at)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">
                {t("taskCenter.detail.meta.completedAt")}
              </div>
              <div className="font-mono text-[11px]">{formatLocalTaskTime(task.completed_at)}</div>
            </div>
          </div>
          {(task.current_task || task.progress > 0) ? (
            <div className="mt-3 rounded bg-muted p-2">
              <div className="text-muted-foreground">当前状态</div>
              <div className="mt-1">{task.current_task || t(`taskCenter.status.${task.status}`)}</div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                {Math.round(task.progress * 100)}%
              </div>
            </div>
          ) : null}
          {providerId ? (
            <div className="mt-3 rounded bg-muted p-2 font-mono text-[11px]">
              {t("taskCenter.detail.meta.providerTaskId")}: {providerId}
            </div>
          ) : null}
          {task.error && (
            <div className="mt-3 rounded bg-destructive/10 p-2 text-destructive">
              <div className="font-medium">{t("taskCenter.detail.error.label")}</div>
              <div className="mt-1">{taskErrorMessage(task, t)}</div>
            </div>
          )}
          {displayResult ? (
            <div className="mt-3">
              <div className="mb-1 font-medium text-muted-foreground">
                {t("taskCenter.detail.result.label")}
              </div>
              <pre className="max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
                {JSON.stringify(displayResult, null, 2)}
              </pre>
            </div>
          ) : null}
          {debugRows.length ? (
            <details className="mt-3 rounded border border-border/60 bg-background/40 p-2">
              <summary className="cursor-pointer text-muted-foreground">调试信息</summary>
              <div className="mt-2 grid gap-1 font-mono text-[11px]">
                {debugRows.map(([label, value]) => (
                  <div key={label} className="truncate">
                    <span className="text-muted-foreground">{debugLabel(label, t)}: </span>
                    <span>{value}</span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </TabsContent>
        <TabsContent value="logs" className="min-h-0 flex-1 overflow-hidden">
          <TaskLogs task={task} />
        </TabsContent>
      </Tabs>
      <TaskActions task={task} />
    </div>
  );
}
