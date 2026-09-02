// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { HTTPError } from "ky";
import i18n from "@/i18n";
import { confirmDialog } from "@/components/confirm-dialog-host";
import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import { useTaskCenterStore } from "@/task-center/store";
import type { OkResponse } from "@/types/api";
import type { Task } from "@/types/task";

interface UseTasksFilter {
  /** Route project id. Legacy task.project may still contain the display/path name. */
  project?: string;
  episode?: number;
}

export interface CancelTaskResult {
  ok: boolean;
  status: string;
  message?: string;
  requires_confirmation?: boolean;
  refund_eligible?: boolean;
  refund_status?: string;
  continued?: boolean;
}

export function useTasks(filter?: UseTasksFilter) {
  const project = filter?.project;
  const taskCenterProjectId = useTaskCenterStore((s) => s.projectId);
  const streamHealth = useTaskCenterStore((s) => s.streamHealth);
  const taskCenterOwnsProject =
    !!project &&
    taskCenterProjectId === project &&
    (streamHealth === "connected" || streamHealth === "polling");

  return useQuery({
    queryKey: queryKeys.tasks(project),
    queryFn: ({ signal }) => {
      if (!project) return Promise.resolve({ ok: true as const, data: [] });
      return api
        .get(p`api/v1/projects/${project}/tasks`, { signal })
        .json<OkResponse<Task[]>>();
    },
    // Task state is live operational data, not ordinary page data. Never
    // inherit the app-wide 30s freshness window: entering a task-aware page
    // (notably 虾料 during ingest) must reconcile against the server now.
    staleTime: 0,
    refetchOnMount: "always",
    // 2s when any task is active for near-real-time updates, 30s otherwise.
    // When the global Task Center owns this project, it is already keeping the
    // query cache fresh via SSE or its own polling fallback.
    refetchInterval: (query) => {
      if (taskCenterOwnsProject) return false;
      const tasks = query.state.data?.data;
      if (
        tasks?.some(
          (t) =>
            t.status === "submitting" ||
            t.status === "queued" ||
            t.status === "pending" ||
            t.status === "starting" ||
            t.status === "running",
        )
      ) {
        return 2000;
      }
      return 30000;
    },
    // Scoped consumers pass a filter so the 2s-5s poll doesn't cause them to
    // re-derive on every unrelated task change. TanStack Query's structural
    // sharing keeps the filtered output identity stable when the filtered
    // slice hasn't actually changed.
    select: filter
      ? (res) => ({
          ...res,
          data: res.data.filter(
            (t) => filter.episode === undefined || t.episode === filter.episode,
          ),
        })
      : undefined,
  });
}

export function useCancelTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      type,
      project,
      episode,
      beatNum,
      scope,
    }: {
      type: string;
      project: string;
      episode: number;
      /** Required for scoped tasks (`single_video`, `grid_regenerate`, etc.) — without it cancel lands on the wrong actor or finds nothing. */
      beatNum?: number;
      /** Required for character/identity/sketch-regen scoped tasks. */
      scope?: string;
    }) => {
      const searchParams: Record<string, string> = {};
      if (beatNum !== undefined) searchParams.beat_num = String(beatNum);
      if (scope) searchParams.scope = scope;
      const path = p`api/v1/projects/${project}/tasks/${type}/${episode}`;
      const send = (force = false) => {
        const params = { ...searchParams };
        if (force) {
          params.force = "true";
          params.acknowledge_no_refund = "true";
        }
        return api
          .delete(path, Object.keys(params).length ? { searchParams: params } : undefined)
          .json<CancelTaskResult>();
      };
      try {
        return await send();
      } catch (error) {
        if (!(error instanceof HTTPError) || error.response.status !== 409) {
          throw error;
        }
        const conflict =
          error.data && typeof error.data === "object"
            ? (error.data as CancelTaskResult)
            : null;
        if (!conflict?.requires_confirmation) throw error;
        const confirmed = await confirmDialog({
          title: i18n.t("tasks.cancelRunning.title"),
          description: conflict.message ?? i18n.t("tasks.cancelRunning.fallbackMessage"),
          confirmText: i18n.t("tasks.cancelRunning.confirm"),
          cancelText: i18n.t("tasks.cancelRunning.keepRunning"),
          confirmVariant: "destructive",
        });
        if (!confirmed) {
          return {
            ...conflict,
            ok: false,
            continued: true,
            message: i18n.t("tasks.cancelRunning.continued"),
          };
        }
        return send(true);
      }
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks(variables.project) });
    },
  });
}

export function useClearCompleted(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.delete(p`api/v1/projects/${project}/tasks/completed`).json<OkResponse<unknown>>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks(project) });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      type,
      project,
      episode,
    }: {
      type: string;
      project: string;
      episode: number;
    }) =>
      api
        .delete(p`api/v1/projects/${project}/tasks/${type}/${episode}`)
        .json<OkResponse<unknown>>(),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks(variables.project) });
    },
  });
}
