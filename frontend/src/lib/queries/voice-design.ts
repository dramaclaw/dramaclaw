// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import {
  voiceDesignCandidateSchema,
  voiceDesignErrorSchema,
  voiceDesignQuoteSchema,
  type VoiceDesignCreate,
  type VoiceDesignSurface,
} from "@/types/voice-design";

export class VoiceDesignApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function readVoiceDesignResponse<T>(
  request: Promise<Response>,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await request;
  const json: unknown = await response.json();
  const error = voiceDesignErrorSchema.safeParse(json);
  if (error.success)
    throw new VoiceDesignApiError(
      error.data.code,
      error.data.error,
      error.data.retryable,
      response.status,
    );
  if (!response.ok)
    throw new VoiceDesignApiError(
      "invalid_response",
      "voiceDesign.errors.invalidResponse",
      false,
      response.status,
    );
  return z.object({ ok: z.literal(true), data: schema }).parse(json).data;
}
export async function createVoiceDesign(
  project: string,
  input: VoiceDesignCreate,
) {
  const result = await readVoiceDesignResponse(
    api.post(p`api/v1/projects/${project}/voice-design/candidates`, {
      json: input,
      retry: 0,
      throwHttpErrors: false,
    }),
    voiceDesignCandidateSchema,
  );
  if (result.candidate_id !== input.request_id)
    throw new Error("voiceDesign.errors.invalidResponse");
  return result;
}
export async function getVoiceDesign(
  project: string,
  id: string,
  signal?: AbortSignal,
) {
  const result = await readVoiceDesignResponse(
    api.get(p`api/v1/projects/${project}/voice-design/candidates/${id}`, {
      signal,
      retry: 0,
      throwHttpErrors: false,
    }),
    voiceDesignCandidateSchema,
  );
  if (result.candidate_id !== id)
    throw new Error("voiceDesign.errors.invalidResponse");
  return result;
}
export function useVoiceDesignQuote(
  project: string,
  surface: VoiceDesignSurface,
) {
  return useQuery({
    queryKey: queryKeys.voiceDesignQuote(project, surface),
    queryFn: ({ signal }) =>
      readVoiceDesignResponse(
        api.get(p`api/v1/projects/${project}/voice-design/quote`, {
          searchParams: { surface },
          signal,
          retry: 0,
          throwHttpErrors: false,
        }),
        voiceDesignQuoteSchema,
      ),
    enabled: !!project,
    retry: false,
    staleTime: 30_000,
  });
}
export async function fetchVoiceDesignAudio(
  url: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await api.get(url.replace(/^\//, ""), {
    signal,
    retry: 0,
    throwHttpErrors: false,
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("audio/")
  ) {
    const parsed = voiceDesignErrorSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (parsed.success)
      throw new VoiceDesignApiError(
        parsed.data.code,
        parsed.data.error,
        parsed.data.retryable,
        response.status,
      );
    throw new Error("voiceDesign.errors.playback");
  }
  return response.blob();
}
