// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ApiResponse } from "@/types/api";

export type PromptModelKind = "llm" | "image" | "video" | "tts" | "none";

export interface PromptPreviewTarget {
  id: string;
  label: string;
}

export interface PromptPreviewStep {
  step: string;
  label: string;
  model_kind: PromptModelKind;
  supported: boolean;
  needs_episode: boolean;
  targets: PromptPreviewTarget[];
}

export interface PromptPart {
  role: "system" | "user" | "image" | "negative";
  label: string;
  text: string;
}

export interface PromptPreview {
  step: string;
  model_kind: PromptModelKind;
  supported: boolean;
  target_label: string;
  parts: PromptPart[];
  inputs: Record<string, unknown>;
  last_sent: { text: string; path: string; mtime: number } | null;
  note: string;
}

function unwrap<T>(body: ApiResponse<T>): T {
  if (!body.ok) throw new Error(body.error);
  return body.data;
}

export function usePromptPreviewSteps(project: string, episode: number | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.promptPreviewSteps(project, episode),
    queryFn: async ({ signal }) =>
      unwrap(
        await jsonWithBackendError<ApiResponse<{ steps: PromptPreviewStep[] }>>(
          api.get(p`api/v1/projects/${project}/prompt-preview/steps`, {
            signal,
            searchParams: episode === null ? {} : { episode },
          }),
        ),
      ).steps,
    enabled: enabled && !!project,
    staleTime: 5_000,
  });
}

export function usePromptPreview(
  project: string,
  step: string | null,
  episode: number | null,
  target: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.promptPreview(project, step ?? "", episode, target),
    queryFn: async ({ signal }) =>
      unwrap(
        await jsonWithBackendError<ApiResponse<PromptPreview>>(
          api.get(p`api/v1/projects/${project}/prompt-preview/${step}`, {
            signal,
            searchParams: {
              ...(episode === null ? {} : { episode }),
              ...(target ? { target } : {}),
            },
          }),
        ),
      ),
    enabled: enabled && !!project && !!step,
    staleTime: 0,
  });
}
