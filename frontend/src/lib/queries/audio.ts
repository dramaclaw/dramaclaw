// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import type { ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type { GenerationCreditCost } from "@/lib/queries/generation-credit-cost";

export interface GenerateAudioParams {
  beatNumbers?: number[];
  mode?: "sync_changed" | "redo_selected" | string;
}

export interface AudioBillingQuote {
  beat_numbers: number[];
  quantity: number;
  unit_cost: number;
  cost: number;
  display: string;
  original_cost?: number;
  discount_amount?: number;
  promotion?: GenerationCreditCost["promotion"];
  prereq_errors: string[];
}

export function useAudioBillingQuote(
  project: string,
  episode: number,
  params: GenerateAudioParams = {},
  revision = "",
) {
  const beatNumbers = params.beatNumbers ?? [];
  const mode = params.mode ?? "sync_changed";
  return useQuery({
    queryKey: [
      "audio-billing-quote",
      project,
      episode,
      mode,
      beatNumbers.join(","),
      revision,
    ] as const,
    queryFn: ({ signal }) =>
      jsonWithBackendError<OkResponse<AudioBillingQuote>>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/audio/billing-quote`,
          {
            json: {
              mode,
              ...(beatNumbers.length > 0 ? { beat_numbers: beatNumbers } : {}),
            },
            signal,
            throwHttpErrors: false,
          },
        ),
      ),
    enabled: !!project && episode > 0,
  });
}

export function useGenerateAudio(project: string, episode: number) {
  return useMutation({
    mutationFn: (params?: GenerateAudioParams) => {
      const body: { beat_numbers?: number[]; mode?: string } = {};
      if (params?.beatNumbers) body.beat_numbers = params.beatNumbers;
      if (params?.mode) body.mode = params.mode;
      return jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/episodes/${episode}/audio/generate`, {
          json: body,
          throwHttpErrors: false,
        }),
      );
    },
  });
}

export function useRegenerateBeatAudio(project: string, episode: number) {
  return useMutation({
    mutationFn: (beatNum: number) =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/beats/${beatNum}/audio`,
          { throwHttpErrors: false },
        ),
      ),
  });
}
