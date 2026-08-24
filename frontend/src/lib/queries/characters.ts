// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { jsonWithBackendError } from "@/lib/api-errors";
import { api, uploadApi } from "@/lib/api";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import { invalidateAssetReferences } from "@/lib/queries/asset-references";
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

export function useCharacters(project: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.characters(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/characters`, { signal })
        .json<OkResponse<Character[]>>(),
    enabled: enabled && !!project,
  });
}

/** Full filesystem-derived state for only the character currently being edited. */
export function useCharacterDetails(
  project: string,
  name: string | null,
  enabled = true,
) {
  const characterName = name?.trim() ?? "";
  return useQuery({
    queryKey: queryKeys.characterDetails(project, characterName),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/characters`, {
          signal,
          searchParams: {
            summary: "false",
            names: characterName,
          },
        })
        .json<OkResponse<Character[]>>(),
    enabled: enabled && !!project && !!characterName,
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
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.characters(project) });
      // 改名走 _cascade_character_rename，它 UPDATE beats 的
      // detected_identities_json 和 visual_description——也就是反向引用索引的两个
      // 来源。资产引用有自己的 project 级 key，characters 的失效碰不到它，卡片会
      // 拿着旧 identity id 的计数继续显示。episodes 前缀顺带覆盖 beats，那些行确
      // 实被重写了。后端用 renamed_from 明确告诉我们级联跑没跑，就按它判。
      if (res.data?.renamed_from) {
        invalidateAssetReferences(qc, project);
        qc.invalidateQueries({ queryKey: queryKeys.episodes(project) });
      }
    },
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
      return uploadApi
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
  qc.invalidateQueries({ queryKey: queryKeys.audioBillingQuotes(project) });
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
      return uploadApi
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
 * Maps `identity_id` → owning character name, to resolve a `?type=identity&id=`
 * deep link to the character that owns it.
 *
 * Built from `identity_ids` on the character list — one request, the same one
 * the page already makes. This used to fan out `/characters/{name}/identities`
 * for every character in the project, unconditionally on mount: a project with
 * 100 characters fired 100 requests on every visit to the assets page, whether
 * or not a deep link was present, to build a lookup table that is usually never
 * read. Identity *details* are still lazy per selected character; only the ids
 * ride along with the list.
 */
export function useIdentityOwnerIndex(project: string, enabled = true) {
  const charactersRes = useQuery({
    queryKey: queryKeys.characters(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/characters`, { signal })
        .json<OkResponse<Character[]>>(),
    enabled: enabled && !!project,
  });

  const characters = charactersRes.data?.data;

  const ownerById = useMemo(() => {
    const acc = new Map<string, string>();
    for (const character of characters ?? []) {
      for (const identityId of character.identity_ids ?? []) {
        acc.set(identityId, character.name);
      }
    }
    return acc;
  }, [characters]);

  return {
    ownerOf: (identityId: string) => ownerById.get(identityId) ?? null,
    isLoading: charactersRes.isLoading,
  };
}

/**
 * Identity create/delete changes which ids a character owns, and that set is
 * also projected into the character list payload as `identity_ids` — which is
 * what `useIdentityOwnerIndex` resolves `?type=identity&id=` deep links
 * against. Invalidating only the identities key leaves that map holding a set
 * that no longer matches, so a link to a just-created identity resolves to no
 * owner while the page stays mounted.
 *
 * Rename counts as a membership change too, even though it neither adds nor
 * removes an entry. `identity_id` is a derived key, not a stable handle:
 * `update_character_identity` rebuilds it as `${char.name}_${new_iname}`
 * whenever `identity_name` is in the payload. The old id therefore stops
 * existing and the list's `identity_ids` still names it, so a deep link to the
 * new id resolves to no owner until the page remounts.
 *
 * Edits that genuinely leave the id alone (appearance, face prompt, age, body
 * type, image generation) do not come through here — refetching the character
 * list for those would be waste.
 */
function invalidateIdentityMembership(
  qc: ReturnType<typeof useQueryClient>,
  project: string,
  name: string,
): void {
  qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) });
  qc.invalidateQueries({ queryKey: queryKeys.characters(project) });
}

export function useCreateIdentity(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { identity_name: string; age_group?: string; appearance_details?: string }) =>
      api.post(p`api/v1/projects/${project}/characters/${name}/identities`, { json: data }).json<OkResponse<Identity>>(),
    onSuccess: () => invalidateIdentityMembership(qc, project, name),
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
    onSuccess: (_res, { data }) => {
      // A rename rewrites identity_id, so the character list's identity_ids
      // goes stale with it. Anything else edits in place and the list is
      // already correct.
      if (data.identity_name !== undefined) {
        invalidateIdentityMembership(qc, project, name);
        return;
      }
      qc.invalidateQueries({ queryKey: queryKeys.identities(project, name) });
    },
  });
}

export function useDeleteIdentity(project: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (identityId: string) =>
      api.delete(p`api/v1/projects/${project}/characters/${name}/identities/${identityId}`).json<OkResponse<unknown>>(),
    onSuccess: () => invalidateIdentityMembership(qc, project, name),
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
      return uploadApi
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
      return uploadApi
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
      return uploadApi
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
