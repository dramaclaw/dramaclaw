// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type { PropAsset } from "@/types/prop";

export interface PropPayload {
  name: string;
  aliases?: string[];
  prop_type?: string;
  visual_prompt?: string;
  description?: string;
  owner?: string;
  notes?: string;
}

export function useProps(project: string) {
  return useQuery({
    queryKey: queryKeys.props(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/props`, { signal })
        .json<OkResponse<PropAsset[]>>(),
    enabled: !!project,
  });
}

export function useCreateProp(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: PropPayload) =>
      api
        .post(p`api/v1/projects/${project}/props`, { json: data })
        .json<OkResponse<PropAsset> | ErrorResponse>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.props(project) }),
  });
}

export function useUpdateProp(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<PropPayload>) =>
      api
        .patch(p`api/v1/projects/${project}/props/${name}`, { json: data })
        .json<OkResponse<PropAsset> | ErrorResponse>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.props(project) });
      qc.invalidateQueries({ queryKey: queryKeys.prop(project, name) });
    },
  });
}

export function useDeleteProp(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api
        .post(p`api/v1/projects/${project}/props/${name}/delete`)
        .json<OkResponse<{ deleted: boolean }> | ErrorResponse>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.props(project) }),
  });
}

export function useGeneratePropReferenceAsync(project: string, name: string) {
  return useMutation<TaskResponse | ErrorResponse, Error, { model?: string } | void>({
    mutationFn: (data: { model?: string } | void) =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/props/${name}/reference/generate-async`, {
          json: data ?? {},
          throwHttpErrors: false,
        }),
      ),
  });
}

/**
 * Upload an image and set it as the prop's reference (`reference_3view.png`).
 *
 * Props have no dedicated upload endpoint, so this mirrors the NiceGUI flow:
 * 1. POST the file to `/freezone/upload` → returns a static `url`.
 * 2. POST `/freezone/push` to write that url back into the canonical `prop_ref` slot.
 */
export function useUploadPropReference(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const uploaded = await api
        .post(p`api/v1/projects/${project}/freezone/upload`, { body: formData })
        .json<OkResponse<{ url: string; filename: string; size: number }>>();

      return api
        .post(p`api/v1/projects/${project}/freezone/push`, {
          json: {
            source_url: uploaded.data.url,
            target: { kind: "prop_ref", prop_id: name },
            mark_stale: true,
          },
        })
        .json<OkResponse<unknown> | ErrorResponse>();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.props(project) });
      qc.invalidateQueries({ queryKey: queryKeys.prop(project, name) });
    },
  });
}

export function useBatchGeneratePropReferences(project: string) {
  const qc = useQueryClient();
  return useMutation<TaskResponse | ErrorResponse, Error, { model?: string } | void>({
    mutationFn: (data: { model?: string } | void) =>
      api
        .post(p`api/v1/projects/${project}/props/reference/batch-generate`, {
          json: data ?? {},
        })
        .json<TaskResponse | ErrorResponse>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tasks(project) }),
  });
}
