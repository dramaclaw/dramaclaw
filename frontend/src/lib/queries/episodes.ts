// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import { jsonWithBackendError } from "@/lib/api-errors";
import { queryKeys } from "@/lib/query-keys";
import type { ApiResponse, ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type {
  Episode,
  Beat,
  EpisodePropMenuItem,
  EpisodeSceneMenuItem,
  PipelineStatus,
  PipelineEpisodeStatus,
} from "@/types/episode";

const LONG_IDENTITY_PLAN_TIMEOUT_MS = 180_000;

export interface EpisodeUpdatePayload {
  title?: string;
  summary?: string;
  content_summary?: string;
  character_names?: string[];
  key_events?: string[];
  cliffhanger?: string;
  identity_ids?: string[];
  beat_source_text?: string;
  identity_default_map?: Record<string, string>;
}

export function useEpisodes(project: string) {
  return useQuery({
    queryKey: queryKeys.episodes(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/episodes`, { signal })
        .json<OkResponse<Episode[]>>(),
    enabled: !!project,
  });
}

export function usePipelineStatus(project: string) {
  return useQuery({
    queryKey: queryKeys.pipelineStatus(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/pipeline/status`, { signal })
        .json<OkResponse<PipelineStatus>>(),
    enabled: !!project,
  });
}

export function derivePipelineEpisodeStatuses(
  status: PipelineStatus | null | undefined,
): PipelineEpisodeStatus[] {
  if (!status?.current_episode || !status.episode_status) return [];
  return [
    {
      episode: status.current_episode,
      script: Boolean(status.episode_status.script),
      sketch: Boolean(status.episode_status.sketches),
      audio: Boolean(status.episode_status.tts),
      video: Boolean(status.episode_status.video),
      compose: status.next_step === "done",
    },
  ];
}

export function mergeEpisodeIntoList(
  episodes: Episode[],
  updatedEpisode: Pick<Episode, "number"> & Partial<Episode>,
): Episode[] {
  let found = false;
  const next = episodes.map((episode) => {
    if (episode.number !== updatedEpisode.number) return episode;
    found = true;
    return { ...episode, ...updatedEpisode };
  });
  if (!found) next.push(updatedEpisode as Episode);
  return next.sort((a, b) => a.number - b.number);
}

function cacheEpisodeUpdate(
  queryClient: QueryClient,
  project: string,
  episode: Episode,
) {
  queryClient.setQueryData<OkResponse<Episode[]> | undefined>(
    queryKeys.episodes(project),
    (old) =>
      old?.ok
        ? { ...old, data: mergeEpisodeIntoList(old.data, episode) }
        : old,
  );
  queryClient.setQueryData<OkResponse<Episode>>(
    queryKeys.episodeDetail(project, episode.number),
    { ok: true, data: episode },
  );
}

export function usePlanEpisodes(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params?: { target_episodes?: number; planning_mode?: string }) =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/episodes/plan`, {
          json: params ?? {},
          throwHttpErrors: false,
        }),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.episodes(project) });
    },
  });
}

export function useUpdateEpisode(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      episodeNum,
      data,
    }: {
      episodeNum: number;
      data: EpisodeUpdatePayload;
    }) =>
      api
        .patch(p`api/v1/projects/${project}/episodes/${episodeNum}`, {
          json: data,
        })
        .json<OkResponse<Episode>>(),
    onSuccess: (_res, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.episodes(project) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.episodeDetail(project, variables.episodeNum),
      });
      if ("beat_source_text" in variables.data) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.script(project, variables.episodeNum),
        });
      }
    },
  });
}

export interface PlanIdentitiesResult {
  new_count: number;
  resolved_count: number;
  identities: {
    character_name: string;
    identity_id: string;
    identity_name: string;
    appearance_details: string;
  }[];
  episode?: Episode;
  logs?: string[];
}

/**
 * Start the per-episode identity planning background task. Returns
 * TaskResponse; completion/failure arrives via the task-center SSE stream.
 * Use `/identities/plan` because both older and newer SuperTale backends
 * expose it as the task-start endpoint.
 */
export function usePlanIdentities(project: string) {
  return useMutation({
    mutationFn: (episodeNum: number) =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episodeNum}/identities/plan`,
          {
            timeout: LONG_IDENTITY_PLAN_TIMEOUT_MS,
            throwHttpErrors: false,
          },
        ),
      ),
  });
}

export interface PlanEpisodeAssetsResult {
  kind: "scene" | "prop";
  total_count: number;
  new_count?: number;
  auto_promoted_props?: string[];
  scene_menu?: EpisodeSceneMenuItem[];
  prop_menu?: EpisodePropMenuItem[];
  episode: Episode;
  logs?: string[];
}

export type PlanEpisodeAssetsResponse =
  | ApiResponse<PlanEpisodeAssetsResult>
  | (TaskResponse & {
      data?: {
        target_episode?: number;
        asset_kind?: "scene" | "prop";
      };
    });

export function isPlanEpisodeAssetsResult(
  res: PlanEpisodeAssetsResponse,
): res is OkResponse<PlanEpisodeAssetsResult> {
  if (res.ok === false) return false;
  const data = "data" in res ? res.data : undefined;
  return Boolean(
    data &&
      typeof data === "object" &&
      "episode" in data &&
      "total_count" in data,
  );
}

function usePlanEpisodeAssets(project: string, kind: "scene" | "prop") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (episodeNum: number) =>
      jsonWithBackendError<PlanEpisodeAssetsResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episodeNum}/${kind === "scene" ? "scenes" : "props"}/plan`,
        ),
      ),
    onSuccess: (res, episodeNum) => {
      if (res.ok === false) return;
      if (isPlanEpisodeAssetsResult(res)) {
        cacheEpisodeUpdate(queryClient, project, res.data.episode);
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.episodes(project) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.episodeDetail(project, episodeNum),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks(project) });
      if (kind === "scene") {
        queryClient.invalidateQueries({ queryKey: queryKeys.scenes(project) });
      } else {
        queryClient.invalidateQueries({ queryKey: queryKeys.props(project) });
      }
    },
  });
}

export function usePlanEpisodeScenes(project: string) {
  return usePlanEpisodeAssets(project, "scene");
}

export function usePlanEpisodeProps(project: string) {
  return usePlanEpisodeAssets(project, "prop");
}

/** Shared query config for an episode's detail — used by the hook and prefetch. */
export function episodeDetailQueryOptions(project: string, episode: number) {
  return {
    queryKey: queryKeys.episodeDetail(project, episode),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api
        .get(p`api/v1/projects/${project}/episodes/${episode}`, { signal })
        .json<OkResponse<Episode>>(),
  };
}

export function useEpisodeDetail(
  project: string,
  episode: number,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...episodeDetailQueryOptions(project, episode),
    enabled: !!project && episode > 0 && (options?.enabled ?? true),
  });
}

/** Warm the episode-detail cache. See {@link prefetchEpisodeBeats}. */
export function prefetchEpisodeDetail(
  qc: QueryClient,
  project: string,
  episode: number,
) {
  if (!project || episode <= 0) return;
  void qc.prefetchQuery(episodeDetailQueryOptions(project, episode));
}

/** Shared query config for an episode's beats list — used by the hook and prefetch. */
export function episodeBeatsQueryOptions(project: string, episode: number) {
  return {
    queryKey: queryKeys.beats(project, episode),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api
        .get(p`api/v1/projects/${project}/episodes/${episode}/beats`, { signal })
        .json<OkResponse<Beat[]>>(),
  };
}

export function useEpisodeBeats(
  project: string,
  episode: number,
  options?: { enabled?: boolean },
) {
  return useQuery({
    ...episodeBeatsQueryOptions(project, episode),
    enabled: !!project && episode > 0 && (options?.enabled ?? true),
  });
}

/**
 * Warm the beats cache for an episode. Called at canvas mount so the per-node
 * BeatContextNode queries (gated on selection) read from cache instead of each
 * firing — and being cancelled (499) — on viewport-virtualized remounts.
 * staleTime is inherited from the global QueryClient default (see src/main.tsx).
 */
export function prefetchEpisodeBeats(
  qc: QueryClient,
  project: string,
  episode: number,
) {
  if (!project || episode <= 0) return;
  void qc.prefetchQuery(episodeBeatsQueryOptions(project, episode));
}

export interface InsertManualShotParams {
  // null ⇒ insert before the first beat. Otherwise insert after this beat_number.
  after_beat_number: number | null;
  visual_description: string;
  duration_seconds?: number | null;
  scene_ref?: { scene_id: string; variant_id?: string } | null;
  time_of_day?: string | null;
  detected_identities?: string[] | null;
  detected_props?: string[] | null;
  audio_type?: "silence" | "narration" | "dialogue";
  speaker?: string | null;
  narration_segment?: string | null;
}

export function useInsertManualShot(project: string, episode: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: InsertManualShotParams) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/insert-manual`,
          { json: data },
        )
        .json<ApiResponse<Beat>>(),
    onSuccess: (res) => {
      if (res.ok === false) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.beats(project, episode),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.script(project, episode),
      });
    },
  });
}

/**
 * Delete a manual-shot beat. The backend rejects deletion of non-manual beats
 * (only `is_manual_shot=true` records are eligible) so the caller must gate
 * the trigger on that flag — typically the trash button is hidden otherwise.
 */
export function useDeleteManualShot(project: string, episode: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (beatNumber: number) =>
      api
        .delete(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNumber}/manual-shot`,
        )
        .json<ApiResponse<{ beats: Beat[] }>>(),
    onSuccess: (res) => {
      if (res.ok === false) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.beats(project, episode),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.script(project, episode),
      });
    },
  });
}
