// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { PanoViewerManifest } from "@/features/viewer-kit/pano/panoManifest";
import type { DirectorStageManifest } from "@/features/viewer-kit/three-d/directorManifest";
import type { ThreeDSceneSnapshot } from "@/features/viewer-kit/three-d/engine/viewerApp";
import { api } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ApiResponse, ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type { SceneAsset, ScenePanoSource, SceneStagePlySource } from "@/types/scene";

export interface ScenePayload {
  name: string;
  aliases?: string[];
  scene_type?: string;
  base_scene_id?: string;
  variant_id?: string;
  time_of_day?: string;
  environment_prompt?: string;
  variant_prompt?: string;
  description?: string;
  notes?: string;
}

export interface ScenePlatePreview {
  scene_id: string;
  variant_id: string;
  time_of_day: string;
  resolved_scene_name: string;
  planned_scene_name: string;
  time_baked: boolean;
  render: {
    resolved_scene_name: string;
    planned_scene_name: string;
    relight: boolean;
    status: "no_time" | "time_baked" | "relight" | "planned_missing";
    label: string;
  };
  seedance2: {
    resolved_scene_name: string;
    prompt_time_of_day: string;
    label: string;
  };
}

export function useScenes(project: string) {
  return useQuery({
    queryKey: queryKeys.scenes(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/scenes`, { signal })
        .json<OkResponse<SceneAsset[]>>(),
    enabled: !!project,
  });
}

export function useScenePlatePreview(
  project: string,
  sceneId: string,
  variantId: string,
  timeOfDay: string,
) {
  const trimmedSceneId = sceneId.trim();
  const trimmedVariantId = variantId.trim();
  const trimmedTimeOfDay = timeOfDay.trim();
  return useQuery({
    queryKey: queryKeys.scenePlatePreview(
      project,
      trimmedSceneId,
      trimmedVariantId,
      trimmedTimeOfDay,
    ),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/scenes/plate-preview`, {
          signal,
          searchParams: {
            scene_id: trimmedSceneId,
            variant_id: trimmedVariantId,
            time_of_day: trimmedTimeOfDay,
          },
        })
        .json<OkResponse<ScenePlatePreview>>(),
    enabled: !!project && !!trimmedSceneId,
  });
}

export function useScenePanoManifest(project: string, name: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.scenePanoManifest(project, name),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/scenes/${name}/pano/manifest`, {
          signal,
        })
        .json<ApiResponse<PanoViewerManifest>>(),
    enabled: enabled && !!project && !!name,
  });
}

export function useUpdateScenePanoCorrection(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (correction: PanoViewerManifest["correction"]) =>
      api
        .patch(p`api/v1/projects/${project}/scenes/${name}/pano/correction`, {
          json: correction,
        })
        .json<ApiResponse<PanoViewerManifest>>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.scenePanoManifest(project, name) });
      qc.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          return (
            Array.isArray(key) &&
            key[0] === "projects" &&
            key[1] === project &&
            key.includes("pano-background-manifest")
          );
        },
      });
    },
  });
}

export function useSceneDirectorStageManifest(project: string, name: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sceneDirectorStageManifest(project, name),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/scenes/${name}/director-stage/manifest`, {
          signal,
        })
        .json<ApiResponse<DirectorStageManifest>>(),
    enabled: enabled && !!project && !!name,
    // Freezone can commit this manifest from a separate app/query cache.
    // Treat mainline reads as externally mutable so tab focus refreshes it.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export interface SceneDirectorWorldPayload {
  active_source_id: string;
  snapshot: ThreeDSceneSnapshot;
  active_source?: Record<string, unknown>;
}

export function useSaveSceneDirectorWorld(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SceneDirectorWorldPayload) =>
      api
        .post(p`api/v1/projects/${project}/scenes/${name}/director-stage/world`, {
          json: payload,
        })
        .json<ApiResponse<{ active_source_id: string }> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.sceneDirectorStageManifest(project, name) });
      qc.invalidateQueries({ queryKey: queryKeys.scenes(project) });
    },
  });
}

export function useClearSceneDirectorWorld(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (activeSourceId: string) =>
      api
        .post(p`api/v1/projects/${project}/scenes/${name}/director-stage/world/clear`, {
          json: { active_source_id: activeSourceId },
        })
        .json<ApiResponse<{ active_source_id: string }> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.sceneDirectorStageManifest(project, name) });
      qc.invalidateQueries({ queryKey: queryKeys.scenes(project) });
    },
  });
}

export function useCreateScene(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ScenePayload) =>
      api
        .post(p`api/v1/projects/${project}/scenes`, { json: data })
        .json<OkResponse<SceneAsset> | ErrorResponse>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.scenes(project) }),
  });
}

export function useUpdateScene(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ScenePayload>) =>
      api
        .patch(p`api/v1/projects/${project}/scenes/${name}`, { json: data })
        .json<OkResponse<SceneAsset> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.scenes(project) });
      qc.invalidateQueries({ queryKey: queryKeys.scene(project, name) });
    },
  });
}

export function useDeleteScene(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api
        .post(p`api/v1/projects/${project}/scenes/${name}/delete`)
        .json<OkResponse<{ deleted: boolean }> | ErrorResponse>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.scenes(project) }),
  });
}

export function useBuildScenes(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/scenes/build`, {
          json: {},
          throwHttpErrors: false,
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tasks(project) }),
  });
}

export function useUploadSceneMaster(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api
        .post(p`api/v1/projects/${project}/scenes/${name}/master/upload`, {
          body: formData,
        })
        .json<OkResponse<{ master_url: string }> | ErrorResponse>();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.scenes(project) }),
  });
}

export function useGenerateSceneMasterAsync(project: string, name: string) {
  return useMutation({
    mutationFn: () =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/scenes/${name}/master/generate-async`, {
          json: {},
          throwHttpErrors: false,
        }),
      ),
  });
}

export function useDeleteSceneMaster(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post(p`api/v1/projects/${project}/scenes/${name}/master/delete`)
        .json<OkResponse<{ deleted: boolean }> | ErrorResponse>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.scenes(project) }),
  });
}

export function useGenerateSceneReverseAsync(project: string, name: string) {
  return useMutation({
    mutationFn: () =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/scenes/${name}/reverse/generate-async`, {
          json: {},
          throwHttpErrors: false,
        }),
      ),
  });
}

export function useUploadScenePano(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api
        .post(p`api/v1/projects/${project}/scenes/${name}/pano/upload`, {
          body: formData,
        })
        .json<OkResponse<{ pano_url: string }> | ErrorResponse>();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.scenes(project) }),
  });
}

export function useUploadSceneCustomPackage(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api
        .post(p`api/v1/projects/${project}/scenes/${name}/custom/upload`, {
          body: formData,
        })
        .json<OkResponse<SceneAsset> | ErrorResponse>();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.scenes(project) }),
  });
}

export function useDeleteSceneCustomPackage(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post(p`api/v1/projects/${project}/scenes/${name}/custom/delete`)
        .json<OkResponse<{ deleted: boolean }> | ErrorResponse>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.scenes(project) }),
  });
}

export function useGenerateScenePanoAsync(project: string, name: string) {
  return useMutation({
    mutationFn: (data: { source: ScenePanoSource }) =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/scenes/${name}/pano/generate-async`, {
          json: data,
          throwHttpErrors: false,
        }),
      ),
  });
}

export function useGenerateScene3gsPlyAsync(project: string, name: string) {
  return useMutation({
    mutationFn: (source: SceneStagePlySource) =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/scenes/${name}/3gs/${source}-ply/generate-async`, {
          json: {},
          throwHttpErrors: false,
        }),
      ),
  });
}

export function useDeleteScenePano(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post(p`api/v1/projects/${project}/scenes/${name}/pano/delete`)
        .json<OkResponse<{ deleted: boolean }> | ErrorResponse>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.scenes(project) }),
  });
}
