// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ApiResponse, OkResponse } from "@/types/api";
import type { Style } from "@/types/style";

export function useStyles(project?: string) {
  return useQuery({
    queryKey: queryKeys.styles(project),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/styles", {
          ...(project ? { searchParams: { project } } : {}),
          signal,
        })
        .json<OkResponse<Style[]>>(),
  });
}

export function useStyleDetail(project: string, id: string | null) {
  return useQuery({
    queryKey: queryKeys.style(id ?? "__none__"),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/styles/${id}`, {
          ...(project ? { searchParams: { project } } : {}),
          signal,
        })
        .json<OkResponse<Style>>(),
    enabled: !!id,
  });
}

export function useCreateStyle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; name: string; project: string; config: Record<string, unknown>; preview_path?: string | null }) =>
      api.post("api/v1/styles", { json: data }).json<ApiResponse<{ id: string }>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["styles"] }),
  });
}

export function useDeleteStyle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ styleId, project }: { styleId: string; project?: string }) =>
      api
        .delete(p`api/v1/styles/${styleId}`, project ? { searchParams: { project } } : undefined)
        .json<OkResponse<unknown>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["styles"] }),
  });
}

export function useAnalyzeStyle(project: string) {
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api
        .post(p`api/v1/projects/${project}/styles/analyze`, {
          body: formData,
          throwHttpErrors: false,
        })
        .json<ApiResponse<Record<string, unknown>>>();
    },
  });
}

export function useUploadStylePreview(project: string) {
  return useMutation({
    mutationFn: async ({ file, styleId }: { file: File; styleId: string }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("style_id", styleId);
      return api
        .post(p`api/v1/projects/${project}/styles/preview-upload`, {
          body: formData,
          throwHttpErrors: false,
        })
        .json<ApiResponse<{ preview_path: string }>>();
    },
  });
}
