// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type { Chapter } from "@/types/episode";
import type { SpineTemplate } from "@/types/project";

export interface FormatCheckIssue {
  code: string;
  line: number | null;
  message: string;
  fix: string;
}

export interface FormatCheck {
  level: "ok" | "warning" | "blocking";
  summary: string;
  issues?: FormatCheckIssue[];
  metrics?: Record<string, number>;
}

export interface UploadResult {
  filename: string;
  size: number;
  total_chars?: number;
  count?: number;
  chapters?: Chapter[];
  format_check?: FormatCheck;
}

interface ChaptersResult {
  chapters: Chapter[];
  total_chars: number;
  count?: number;
}

export function useUploadNovel(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const response = await jsonWithBackendError<OkResponse<UploadResult> | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/ingest/upload`, { body: formData }),
      );
      if (!response.ok) {
        throw new Error(response.error);
      }
      return response;
    },
    onSuccess: (response) => {
      const preview = response.data;
      if (
        Array.isArray(preview.chapters) &&
        typeof preview.total_chars === "number"
      ) {
        queryClient.setQueryData<OkResponse<ChaptersResult>>(
          queryKeys.chapters(project),
          {
            ok: true,
            data: {
              chapters: preview.chapters,
              total_chars: preview.total_chars,
              count: preview.count,
            },
          },
        );
        return;
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.chapters(project) });
    },
  });
}

export function useChapters(project: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.chapters(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/chapters`, { signal })
        .json<OkResponse<ChaptersResult>>(),
    enabled: !!project && enabled,
  });
}

export function useStartIngest(project: string) {
  return useMutation({
    mutationFn: async (params: {
      filename: string;
      rebuild?: boolean;
      spine_template?: SpineTemplate;
    }) => {
      const response = await jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/ingest/start`, {
          json: params,
          throwHttpErrors: false,
        }),
      );
      if (!response.ok) {
        throw new Error(response.error);
      }
      return response;
    },
  });
}
