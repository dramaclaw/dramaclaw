// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from "react";
import {
  useQueries,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryFunctionContext } from "@tanstack/react-query";
import { jsonWithBackendError } from "@/lib/api-errors";
import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { ErrorResponse, OkResponse, TaskResponse } from "@/types/api";
import type {
  Character,
  CharacterAssetHistory,
  CharacterAssetKind,
  CharacterAssetRestoreResult,
  CharacterVoiceSamples,
  CharacterVoiceSlot,
  Identity,
  IdentityAttempts,
} from "@/types/character";

export type CharacterUpdateResponse = {
  name: string;
  updated_fields: string[];
  renamed_from?: string;
};

export function useCharacters(project: string) {
  return useQuery({
    queryKey: queryKeys.characters(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/characters`, { signal })
        .json<OkResponse<Character[]>>(),
    enabled: !!project,
  });
}

export function useBuildCharacters(project: string) {
  return useMutation({
    mutationFn: () =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/characters/build`, {
          json: {},
          throwHttpErrors: false,
        }),
      ),
  });
}

export function useCreateCharacter(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; role?: string; gender?: string; is_main?: boolean; description?: string; face_prompt?: string }) =>
      api.post(p`api/v1/projects/${project}/characters`, { json: data }).json<OkResponse<Character>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.characters(project) }),
  });
}

export function useUpdateCharacter(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Character>) =>
      api
        .patch(p`api/v1/projects/${project}/characters/${name}`, { json: data })
        .json<OkResponse<CharacterUpdateResponse>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.characters(project) }),
  });
}

export function useDeleteCharacter(project: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api
        .post(p`api/v1/projects/${project}/characters/${name}/delete`)
        .json<OkResponse<unknown>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.characters(project) }),
  });
}

const LONG_IMAGE_GEN_TIMEOUT_MS = 180_000;

function linkedApiPath(url: string): string {
  return url.replace(/^\/+/, "");
}

type IdentityGenerationInput =
  | string
  | {
      identityId: string;
      style?: string;
      model?: string;
    };

function identityGenerationPayload(input: IdentityGenerationInput): {
  identityId: string;
  body: { style?: string; model?: string };
} {
  if (typeof input === "string") {
    return { identityId: input, body: {} };
  }
  const { identityId, style, model } = input;
  return {
    identityId,
    body: {
      style,
      model,
    },
  };
}

export function useGeneratePortrait(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data?: { style?: string; ethnicity?: string; model?: string }) =>
      api
        .post(p`api/v1/projects/${project}/characters/${name}/portrait`, {
          json: data ?? {},
          timeout: LONG_IMAGE_GEN_TIMEOUT_MS,
        })
        .json<OkResponse<{ portrait_url: string }>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.characters(project) }),
  });
}

/**
 * Async variant — dispatches a `character_portrait` task and returns
 * TaskResponse. Progress + completion/failure arrive via the task-center
 * SSE stream (use together with useTaskController on the caller side).
 * The sync endpoint is kept for back-compat.
 */
export function useGeneratePortraitAsync(project: string, name: string) {
  return useMutation({
    mutationFn: (data?: { style?: string; ethnicity?: string; model?: string }) =>
      jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(p`api/v1/projects/${project}/characters/${name}/portrait-async`, {
          json: data ?? {},
          throwHttpErrors: false,
        }),
      ),
  });
}

export function useUploadPortrait(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api
        .post(p`api/v1/projects/${project}/characters/${name}/portrait/upload`, { body: formData })
        .json<OkResponse<{ portrait_url: string }>>();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.characters(project) }),
  });
}

export function useCharacterAssetHistory(
  project: string,
  name: string,
  historyUrl: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? true;
  return useQuery({
    queryKey: queryKeys.characterAssetHistory(project, name, historyUrl ?? ""),
    queryFn: ({ signal }) =>
      api
        .get(linkedApiPath(historyUrl ?? ""), { signal })
        .json<OkResponse<CharacterAssetHistory> | ErrorResponse>(),
    enabled: !!project && !!name && !!historyUrl && enabled,
  });
}

export function useRestoreCharacterAsset(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      restoreUrl,
      kind,
      historyId,
      identityId,
    }: {
      restoreUrl: string;
      kind: CharacterAssetKind;
      historyId: string;
      identityId?: string;
    }) =>
      jsonWithBackendError<OkResponse<CharacterAssetRestoreResult> | ErrorResponse>(
        api.post(linkedApiPath(restoreUrl), {
          json: {
            kind,
            history_id: historyId,
            identity_id: identityId || undefined,
          },
          throwHttpErrors: false,
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.characters(project) });
      qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) });
      qc.invalidateQueries({ queryKey: queryKeys.characterAssetHistories(project, name) });
    },
  });
}

function invalidateCharacterVoiceQueries(
  qc: ReturnType<typeof useQueryClient>,
  project: string,
  name: string,
) {
  qc.invalidateQueries({ queryKey: queryKeys.characters(project) });
  qc.invalidateQueries({ queryKey: queryKeys.characterVoiceSamples(project, name) });
}

function updateCharacterVoiceCache(
  qc: ReturnType<typeof useQueryClient>,
  project: string,
  name: string,
  response: OkResponse<CharacterVoiceSlot> | ErrorResponse,
) {
  if (!response.ok) return;
  const slot = response.data;
  const slotId = String(slot.slot);
  qc.setQueryData<OkResponse<Character[]> | undefined>(
    queryKeys.characters(project),
    (current) => {
      if (!current?.ok) return current;
      return {
        ...current,
        data: current.data.map((character) => {
          if (character.name !== name) return character;
          if (slotId === "default") {
            return {
              ...character,
              reference_audio_path: slot.path,
              reference_audio_url: slot.url,
              reference_audio_sha256: slot.sha256,
              reference_audio_updated_at: slot.updated_at,
            };
          }
          const voiceSamples = {
            ...(character.voice_samples_by_age_group ?? {}),
          };
          if (slot.path) {
            voiceSamples[slotId] = {
              path: slot.path,
              sha256: slot.sha256,
              updated_at: slot.updated_at,
            };
          } else {
            delete voiceSamples[slotId];
          }
          return {
            ...character,
            voice_samples_by_age_group: voiceSamples,
          };
        }),
      };
    },
  );
}

function handleCharacterVoiceMutationSuccess(
  qc: ReturnType<typeof useQueryClient>,
  project: string,
  name: string,
  response: OkResponse<CharacterVoiceSlot> | ErrorResponse,
) {
  updateCharacterVoiceCache(qc, project, name, response);
  invalidateCharacterVoiceQueries(qc, project, name);
}

export function useCharacterVoiceSamples(project: string, name: string) {
  return useQuery({
    queryKey: queryKeys.characterVoiceSamples(project, name),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/characters/${name}/voice-samples`, {
          signal,
        })
        .json<OkResponse<CharacterVoiceSamples>>(),
    enabled: !!project && !!name,
  });
}

export function useUploadCharacterVoiceSample(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ slot, file }: { slot: string; file: File }) => {
      const formData = new FormData();
      formData.append("file", file, file.name);
      return api
        .post(
          p`api/v1/projects/${project}/characters/${name}/voice-samples/${slot}/upload`,
          { body: formData },
        )
        .json<OkResponse<CharacterVoiceSlot> | ErrorResponse>();
    },
    onSuccess: (response) =>
      handleCharacterVoiceMutationSuccess(qc, project, name, response),
  });
}

export function useRecordCharacterVoiceSample(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slot, dataUrl }: { slot: string; dataUrl: string }) =>
      api
        .post(
          p`api/v1/projects/${project}/characters/${name}/voice-samples/${slot}/record`,
          { json: { data_url: dataUrl } },
        )
        .json<OkResponse<CharacterVoiceSlot> | ErrorResponse>(),
    onSuccess: (response) =>
      handleCharacterVoiceMutationSuccess(qc, project, name, response),
  });
}

export function useTrimCharacterVoiceSample(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      slot,
      sourcePath,
      startSeconds,
      durationSeconds,
    }: {
      slot: string;
      sourcePath: string;
      startSeconds: number;
      durationSeconds: number;
    }) =>
      api
        .post(
          p`api/v1/projects/${project}/characters/${name}/voice-samples/${slot}/trim`,
          {
            json: {
              source_path: sourcePath,
              start_seconds: startSeconds,
              duration_seconds: durationSeconds,
            },
          },
        )
        .json<OkResponse<CharacterVoiceSlot> | ErrorResponse>(),
    onSuccess: (response) =>
      handleCharacterVoiceMutationSuccess(qc, project, name, response),
  });
}

export function useDeleteCharacterVoiceSample(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slot: string) =>
      api
        .post(
          p`api/v1/projects/${project}/characters/${name}/voice-samples/${slot}/delete`,
        )
        .json<OkResponse<CharacterVoiceSlot> | ErrorResponse>(),
    onSuccess: (response) =>
      handleCharacterVoiceMutationSuccess(qc, project, name, response),
  });
}

export function useCharacterIdentities(project: string, name: string) {
  return useQuery({
    queryKey: queryKeys.identities(project, name),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/characters/${name}/identities`, {
          signal,
        })
        .json<OkResponse<Identity[]>>(),
    enabled: !!project && !!name,
  });
}

/**
 * Maps `identity_id` → owning character name by fanning out the per-character
 * identity lists. Used to resolve a `?type=identity&id=` deep link to the
 * character that owns it (the identity list is otherwise lazy-loaded per
 * selected character). React Query dedupes these with the per-card fetches.
 */
export function useIdentityOwnerIndex(project: string) {
  const charactersRes = useQuery({
    queryKey: queryKeys.characters(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/characters`, { signal })
        .json<OkResponse<Character[]>>(),
    enabled: !!project,
  });

  const names = useMemo(
    () => (charactersRes.data?.data ?? []).map((c) => c.name),
    [charactersRes.data?.data],
  );

  const identityQueries = useQueries({
    queries: names.map((name) => ({
      queryKey: queryKeys.identities(project, name),
      queryFn: ({ signal }: QueryFunctionContext) =>
        api
          .get(p`api/v1/projects/${project}/characters/${name}/identities`, {
            signal,
          })
          .json<OkResponse<Identity[]>>(),
      enabled: !!project && !!name,
    })),
  });

  const dataSignature = identityQueries.map((q) => q.dataUpdatedAt).join(",");
  const identitiesByCharacter = identityQueries.map((q) => q.data?.data);

  const ownerById = useMemo(() => {
    const acc = new Map<string, string>();
    identitiesByCharacter.forEach((identities, i) => {
      const name = names[i];
      if (!identities) return;
      for (const identity of identities) {
        acc.set(identity.identity_id, name);
      }
    });
    return acc;
  }, [names, dataSignature]);

  return {
    ownerOf: (identityId: string) => ownerById.get(identityId) ?? null,
    isLoading: charactersRes.isLoading || identityQueries.some((q) => q.isLoading),
  };
}

export function useCreateIdentity(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { identity_name: string; age_group?: string; appearance_details?: string }) =>
      api.post(p`api/v1/projects/${project}/characters/${name}/identities`, { json: data }).json<OkResponse<Identity>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) }),
  });
}

export function useUpdateIdentity(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      identityId,
      data,
    }: {
      identityId: string;
      data: {
        identity_name?: string;
        appearance_details?: string;
        face_prompt?: string;
        age_group?: string;
        body_type?: string;
      };
    }) =>
      api.patch(p`api/v1/projects/${project}/characters/${name}/identities/${identityId}`, { json: data }).json<OkResponse<Identity>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) }),
  });
}

export function useDeleteIdentity(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (identityId: string) =>
      api.delete(p`api/v1/projects/${project}/characters/${name}/identities/${identityId}`).json<OkResponse<unknown>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) }),
  });
}

export function useGenerateIdentityImage(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IdentityGenerationInput) => {
      const { identityId, body } = identityGenerationPayload(input);
      return api
        .post(p`api/v1/projects/${project}/characters/${name}/identities/${identityId}/generate`, {
          json: body,
          timeout: LONG_IMAGE_GEN_TIMEOUT_MS,
        })
        .json<OkResponse<{ image_url: string }>>();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) }),
  });
}

/** Async variant — dispatches an `identity_image` task; sync kept for back-compat. */
export function useGenerateIdentityImageAsync(project: string, name: string) {
  return useMutation({
    mutationFn: (input: IdentityGenerationInput) => {
      const { identityId, body } = identityGenerationPayload(input);
      return jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(
          p`api/v1/projects/${project}/characters/${name}/identities/${identityId}/generate-async`,
          { json: body, throwHttpErrors: false },
        ),
      );
    },
  });
}

export function useUploadIdentityImage(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ identityName, file }: { identityName: string; file: File }) => {
      const formData = new FormData();
      formData.append("file", file);
      return api
        .post(p`api/v1/projects/${project}/characters/${name}/identities/${identityName}/upload`, { body: formData })
        .json<OkResponse<{ image_url: string }>>();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) }),
  });
}

export function useUploadCostumeImage(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ identityId, file }: { identityId: string; file: File }) => {
      const formData = new FormData();
      formData.append("file", file);
      return api
        .post(p`api/v1/projects/${project}/characters/${name}/identities/${identityId}/costume/upload`, { body: formData })
        .json<OkResponse<{ costume_image_url: string }>>();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) }),
  });
}

export function useDeleteIdentityCostume(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (identityId: string) =>
      api
        .post(p`api/v1/projects/${project}/characters/${name}/identities/${identityId}/costume/delete`)
        .json<OkResponse<{ deleted: boolean }>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) }),
  });
}

export function useDeleteIdentityImage(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (identityId: string) =>
      api
        .post(p`api/v1/projects/${project}/characters/${name}/identities/${identityId}/image/delete`)
        .json<OkResponse<{ deleted: boolean }>>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) }),
  });
}

export function useUploadIdentityPortrait(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ identityId, file }: { identityId: string; file: File }) => {
      const formData = new FormData();
      formData.append("file", file);
      return api
        .post(p`api/v1/projects/${project}/characters/${name}/identities/${identityId}/portrait/upload`, { body: formData })
        .json<OkResponse<{ portrait_image_url: string }>>();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) }),
  });
}

export function useGenerateIdentityPortrait(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IdentityGenerationInput) => {
      const { identityId, body } = identityGenerationPayload(input);
      return api
        .post(p`api/v1/projects/${project}/characters/${name}/identities/${identityId}/portrait/generate`, {
          json: body,
          timeout: LONG_IMAGE_GEN_TIMEOUT_MS,
        })
        .json<OkResponse<{ portrait_image_url: string }>>();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) }),
  });
}

/** Async variant — dispatches an `identity_portrait` task; sync kept for back-compat. */
export function useGenerateIdentityPortraitAsync(project: string, name: string) {
  return useMutation({
    mutationFn: (input: IdentityGenerationInput) => {
      const { identityId, body } = identityGenerationPayload(input);
      return jsonWithBackendError<TaskResponse | ErrorResponse>(
        api.post(
          p`api/v1/projects/${project}/characters/${name}/identities/${identityId}/portrait/generate-async`,
          { json: body, throwHttpErrors: false },
        ),
      );
    },
  });
}

export function useIdentityAttempts(project: string, name: string, identityId: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.identities(project, name), identityId, "attempts"],
    queryFn: ({ signal }) =>
      api
        .get(
          p`api/v1/projects/${project}/characters/${name}/identities/${identityId}/attempts`,
          { signal },
        )
        .json<OkResponse<IdentityAttempts> | ErrorResponse>(),
    enabled: !!project && !!name && !!identityId,
    staleTime: 0,
  });
}
