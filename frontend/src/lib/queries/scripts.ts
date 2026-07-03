// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type { Script, BeatUpdate } from "@/types/script";
import type { Beat } from "@/types/episode";

export function useScript(project: string, episode: number) {
  return useQuery({
    queryKey: queryKeys.script(project, episode),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/episodes/${episode}/script`, { signal })
        .json<OkResponse<Script | null>>(),
    enabled: !!project && episode > 0,
  });
}

export function useGenerateScript(project: string, episode: number) {
  return useMutation({
    mutationFn: (params?: { target_duration_total?: number; rhythm?: string }) =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/episodes/${episode}/script/generate`, {
          json: params ?? {},
          throwHttpErrors: false,
        }),
      ),
  });
}

export function useGenerateRewrite(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params?: {
      target_beats?: number;
      beat_chars_min?: number;
      beat_chars_max?: number;
      narration_style?: string;
    }) =>
      api
        .post(p`api/v1/projects/${project}/episodes/${episode}/rewrite/generate`, {
          json: params ?? {},
        })
        .json<OkResponse<{
          episode: number;
          line_count: number;
          adapted_content: string;
          used_fallback: boolean;
        }> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.episodeDetail(project, episode) });
      qc.invalidateQueries({ queryKey: queryKeys.script(project, episode) });
    },
  });
}

export function useUpdateBeat(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ beatNum, data }: { beatNum: number; data: BeatUpdate }) =>
      api
        .patch(p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}`, {
          json: data,
        })
        .json<OkResponse<Beat>>(),
    // Patch the touched beat into the cache instead of invalidating the whole
    // episode list. The response already carries the updated Beat; fanning
    // out a refetch forces every BeatCard to re-render on every field save.
    //
    // Merge (not replace): the PATCH response only carries script-JSON fields,
    // not the file-derived URLs (`video_url`, `audio_url`, `frame_url`) that
    // the GET endpoint injects per-request. Replacing wholesale would wipe
    // those URLs on every text-save, making the beat appear ungenerated.
    onSuccess: (res, { beatNum }) => {
      const patched = res.data;
      if (patched) {
        qc.setQueryData<OkResponse<Beat[]>>(
          queryKeys.beats(project, episode),
          (old) => {
            if (!old?.data) return old;
            return {
              ...old,
              data: old.data.map((b) =>
                b.beat_number === beatNum ? { ...b, ...patched } : b,
              ),
            };
          },
        );
      }
      // Script view derives its text from the aggregated script payload; a
      // beat edit can change that, so keep it in sync lazily.
      qc.invalidateQueries({ queryKey: queryKeys.script(project, episode) });
    },
  });
}

export function useSaveScript(project: string, episode: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (beats: Beat[]) =>
      api
        .put(p`api/v1/projects/${project}/episodes/${episode}/script`, {
          json: { beats },
        })
        .json<OkResponse<{ episode: number; beats_count: number }>>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.script(project, episode) });
    },
  });
}
