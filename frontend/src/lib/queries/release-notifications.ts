// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";

export type ReleaseAttention = "low" | "medium" | "high";

export interface ReleaseItem {
  id: string;
  kind: string;
  icon: string;
  title: string;
  body: string;
}

export interface ReleaseFeed {
  source: "local_file" | "local_file+github" | "none";
  current_version: string | null;
  current_tag: string | null;
  current_items: ReleaseItem[];
  update_available: boolean;
  latest_version: string | null;
  latest_tag: string | null;
  release_url: string | null;
  update_items: ReleaseItem[];
  attention: ReleaseAttention;
  latest_published_at: string | null;
}

const RELEASE_FEED_STALE_TIME_MS = 60 * 60 * 1000;

export function normalizeReleaseLocale(locale: string | undefined): "zh" | "en" {
  const two = (locale ?? "").slice(0, 2).toLowerCase();
  return two === "en" ? "en" : "zh";
}

export function releaseNotificationsQueryOptions(localeInput: string | undefined) {
  const locale = normalizeReleaseLocale(localeInput);
  return {
    queryKey: queryKeys.releaseNotifications(locale),
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      fetchReleaseNotifications(locale, signal),
    staleTime: RELEASE_FEED_STALE_TIME_MS,
    refetchOnWindowFocus: true,
  };
}

export function fetchReleaseNotifications(
  localeInput: string | undefined,
  signal?: AbortSignal,
): Promise<OkResponse<ReleaseFeed>> {
  const locale = normalizeReleaseLocale(localeInput);
  return api
    .get("api/v1/release-notifications", {
      searchParams: { locale },
      signal,
    })
    .json<OkResponse<ReleaseFeed>>();
}

export function ensureReleaseNotifications(
  queryClient: QueryClient,
  localeInput: string | undefined,
): Promise<OkResponse<ReleaseFeed>> {
  return queryClient.ensureQueryData(releaseNotificationsQueryOptions(localeInput));
}

export function useReleaseNotifications(localeOverride?: string) {
  const locale = normalizeReleaseLocale(localeOverride);
  return useQuery(releaseNotificationsQueryOptions(locale));
}
