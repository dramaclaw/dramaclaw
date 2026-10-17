// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse, OkResponse } from "@/types/api";
import type { FastApiErrorResponse } from "@/lib/queries/model-gateway";

export interface RunpodWorkerLiveCounts {
  idle: number;
  initializing: number;
  ready: number;
  running: number;
  throttled: number;
  unhealthy: number;
}

export interface RunpodWorkerJobCounts {
  completed: number;
  failed: number;
  inProgress: number;
  inQueue: number;
  retried: number;
}

export interface RunpodWorkerStatus {
  configured: boolean;
  running: boolean;
  endpointId?: string;
  endpointName?: string;
  workers?: {
    max: number;
    min: number;
    idleTimeoutSeconds: number;
  };
  /** null when the last RunPod health check itself failed (not when cold). */
  live?: RunpodWorkerLiveCounts | null;
  jobs?: RunpodWorkerJobCounts | null;
}

type RunpodWorkerResponse =
  | OkResponse<RunpodWorkerStatus>
  | ErrorResponse
  | FastApiErrorResponse;

/** Dev-only RunPod Qwen Image 2.1 worker status — see Settings → Models.
 * Polls faster while a worker is mid-boot so the Start button's spinner
 * resolves promptly, slower once things have settled. */
export function useRunpodWorkerStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.runpodWorker(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/runpod-worker/status", { signal })
        .json<OkResponse<RunpodWorkerStatus>>(),
    enabled,
    refetchInterval: (query) => {
      const live = query.state.data?.data.live;
      return live && live.initializing > 0 ? 5_000 : 20_000;
    },
  });
}

export function useStartRunpodWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post("api/v1/runpod-worker/start", {
          timeout: 30_000,
          throwHttpErrors: false,
        })
        .json<RunpodWorkerResponse>(),
    onSuccess: (response) => {
      if (response.ok === true) {
        qc.setQueryData(queryKeys.runpodWorker(), response);
      } else {
        qc.invalidateQueries({ queryKey: queryKeys.runpodWorker() });
      }
    },
  });
}

export function useStopRunpodWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post("api/v1/runpod-worker/stop", {
          timeout: 30_000,
          throwHttpErrors: false,
        })
        .json<RunpodWorkerResponse>(),
    onSuccess: (response) => {
      if (response.ok === true) {
        qc.setQueryData(queryKeys.runpodWorker(), response);
      } else {
        qc.invalidateQueries({ queryKey: queryKeys.runpodWorker() });
      }
    },
  });
}
