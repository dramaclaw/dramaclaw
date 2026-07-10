// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";

export type AppUpdateMode = "none" | "manual" | "self_update";
export type AppUpdatePhase = "idle" | "downloading" | "verifying" | "launching" | "failed";

export interface AppUpdateProgress {
  phase: AppUpdatePhase;
  percent: number;
  error: string | null;
  target_tag: string | null;
}

export interface AppUpdateStatus {
  mode: AppUpdateMode;
  mode_reason?: string;
  current_version: string | null;
  update_available: boolean;
  latest_tag: string | null;
  release_url: string | null;
  asset_name: string | null;
  asset_size: number | null;
  progress: AppUpdateProgress;
}

const APP_UPDATE_STALE_TIME_MS = 5 * 60 * 1000;

export function fetchAppUpdateStatus(
  signal?: AbortSignal,
): Promise<OkResponse<AppUpdateStatus>> {
  return api.get("api/v1/app-update/status", { signal }).json<OkResponse<AppUpdateStatus>>();
}

export function useAppUpdateStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.appUpdateStatus(),
    queryFn: ({ signal }) => fetchAppUpdateStatus(signal),
    staleTime: APP_UPDATE_STALE_TIME_MS,
    enabled,
  });
}

export function applyAppUpdate(): Promise<
  OkResponse<{ started: boolean; target_tag: string | null }>
> {
  return api
    .post("api/v1/app-update/apply")
    .json<OkResponse<{ started: boolean; target_tag: string | null }>>();
}
