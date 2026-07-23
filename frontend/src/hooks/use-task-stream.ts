// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import {
  backendErrorCodeToastMessage,
  backendErrorToastMessage,
  errorFromBackendBody,
  humanizeTaskError,
} from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import type { TaskStatus, TaskStreamEvent } from "@/types/task";

interface UseTaskStreamOptions {
  taskType: string;
  /** Route project id. */
  project: string;
  episode: number;
  beatNum?: number;
  scope?: string;
  enabled?: boolean;
  onComplete?: (result: unknown) => void;
  onError?: (error: string) => void;
  invalidateKeys?: QueryKey[];
  showCompleteToast?: boolean;
}

interface TaskStreamState {
  status: "idle" | TaskStatus;
  progress: number;
  currentTask: string;
  result: unknown | null;
  error: string | null;
  logs: string[];
}

export function useTaskStream(options: UseTaskStreamOptions): TaskStreamState {
  const {
    taskType,
    project,
    episode,
    beatNum,
    scope,
    enabled = true,
    invalidateKeys,
    showCompleteToast = true,
  } = options;

  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // Cookie-backed auth: the SPA does not persist a raw credential. Gate
  // on `username` (set once /auth/login succeeds) to know we're logged in;
  // the EventSource connection carries the HttpOnly cookie automatically
  // when opened with `withCredentials: true`.
  const username = useAuthStore((s) => s.username);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Store callbacks in refs to avoid reconnection thrashing
  // when consumers pass inline arrow functions
  const onCompleteRef = useRef(options.onComplete);
  onCompleteRef.current = options.onComplete;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const invalidateKeysRef = useRef(invalidateKeys);
  invalidateKeysRef.current = invalidateKeys;

  const [state, setState] = useState<TaskStreamState>({
    status: "idle",
    progress: 0,
    currentTask: "",
    result: null,
    error: null,
    logs: [],
  });

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const taskErrorMessage = useCallback(
    (data: Pick<TaskStreamEvent, "error" | "error_code">, fallback: string) => {
      const message = data.error || fallback;
      const localized = backendErrorCodeToastMessage(data.error_code, message, t);
      if (localized) return localized;
      const status = data.error_code === "INSUFFICIENT_CREDITS" ? 402 : 409;
      const parsed = data.error_code
        ? errorFromBackendBody(
            status,
            {
              ok: false,
              error: message,
              data: { error_code: data.error_code },
            },
            message,
          )
        : null;
      if (parsed) return backendErrorToastMessage(parsed, t);
      return humanizeTaskError(message, t);
    },
    [t],
  );

  useEffect(() => {
    if (!enabled || !username) {
      cleanup();
      return;
    }

    const params = new URLSearchParams();
    if (beatNum !== undefined) params.set("beat_num", String(beatNum));
    if (scope) params.set("scope", scope);
    const qs = params.toString();

    const base = p`/api/v1/projects/${project}/tasks/${taskType}/${episode}/stream`;
    const url = qs ? `${base}?${qs}` : base;
    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    const handleEvent = (e: MessageEvent) => {
      try {
        const data: TaskStreamEvent = JSON.parse(e.data);
        setState({
          status: data.status,
          progress: data.progress ?? 0,
          currentTask: data.current_task ?? "",
          result: data.result ?? null,
          error: data.error ?? null,
          logs: Array.isArray(data.logs) ? data.logs.filter((x) => typeof x === "string") : [],
        });

        if (data.status === "completed") {
          cleanup();
          if (invalidateKeysRef.current) {
            invalidateKeysRef.current.forEach((key) =>
              queryClient.invalidateQueries({ queryKey: key }),
            );
          }
          if (showCompleteToast) {
            toast.success(data.current_task || "Task completed");
          }
          onCompleteRef.current?.(data.result);
        } else if (data.status === "failed") {
          cleanup();
          const message = taskErrorMessage(data, "Task failed");
          toast.error(message);
          onErrorRef.current?.(message);
        } else if (data.status === "cancelled") {
          cleanup();
          const message = taskErrorMessage(data, "Task cancelled");
          toast.error(message);
          onErrorRef.current?.(message);
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.addEventListener("submitting", handleEvent);
    es.addEventListener("queued", handleEvent);
    es.addEventListener("pending", handleEvent);
    es.addEventListener("starting", handleEvent);
    es.addEventListener("running", handleEvent);
    es.addEventListener("completed", handleEvent);
    es.addEventListener("failed", handleEvent);
    es.addEventListener("cancelled", handleEvent);

    // Backend emits a named `error` event with `{error: "Task not found"}`
    // when the stream's (type, project, episode, beat_num, scope) lookup
    // can't find a matching row. Previously this was unhandled, so the
    // EventSource would silently auto-reconnect in a tight loop against
    // a missing task — callers' `invalidateKeys` would never fire.
    // Treat it as a terminal failure so the UI unsticks.
    es.addEventListener("error", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const msg = data?.error || "Task not found";
        setState((prev) => ({ ...prev, status: "failed", error: msg }));
        cleanup();
        const message = taskErrorMessage(
          { error: msg, error_code: data?.error_code },
          "Task not found",
        );
        toast.error(message);
        onErrorRef.current?.(message);
      } catch {
        // Not a structured error event — likely just a plain network
        // error. Leave the default auto-reconnect behavior.
      }
    });

    es.onerror = () => {
      // Plain network-level error (connection drop). EventSource
      // auto-reconnects; if task finished while disconnected, server
      // resends terminal event on reconnect.
    };

    return cleanup;
  }, [
    enabled,
    username,
    taskType,
    project,
    episode,
    beatNum,
    scope,
    cleanup,
    queryClient,
    showCompleteToast,
    taskErrorMessage,
  ]);

  // Region-switch teardown: the orchestrator dispatches a window
  // "region-switch" event just before the hard reload. The regionAbortController
  // only aborts fetches, not EventSource connections, so close the SSE stream
  // explicitly here. Otherwise the stream would keep reconnecting and 401 the
  // moment the region cookie flips.
  useEffect(() => {
    const handler = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
    window.addEventListener("region-switch", handler);
    return () => window.removeEventListener("region-switch", handler);
  }, []);

  return state;
}
