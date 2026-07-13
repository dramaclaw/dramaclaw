// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import type { OkResponse } from "@/types/api";

export type CharacterImageSelection = {
  character_image_selection: string;
  options: Record<string, string>;
};

export type AssetImageSourceKind = "character" | "scene" | "prop";

export type AssetImageSourceSelection = {
  asset_kind: AssetImageSourceKind;
  image_source_selection: string;
  options: Record<string, string>;
};

export type CharacterImageUsage = {
  today_requests: number;
  total_requests: number;
};

export const characterImageSelectionQueryKey = (project: string) =>
  ["projects", project, "character-image-selection"] as const;

export const characterImageUsageQueryKey = (project: string) =>
  ["projects", project, "character-image-usage"] as const;

export const assetImageSourceSelectionQueryKey = (
  project: string,
  kind: AssetImageSourceKind,
) => ["projects", project, "image-source-selection", kind] as const;

export function useAssetImageSourceSelection(
  project: string,
  kind: AssetImageSourceKind,
) {
  return useQuery({
    queryKey: assetImageSourceSelectionQueryKey(project, kind),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/image-source-selection/${kind}`, {
          signal,
        })
        .json<OkResponse<AssetImageSourceSelection>>(),
    enabled: !!project && !!kind,
  });
}

export function useCharacterImageSelection(project: string) {
  return useQuery({
    queryKey: characterImageSelectionQueryKey(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/character-image-selection`, { signal })
        .json<OkResponse<CharacterImageSelection>>(),
    enabled: !!project,
  });
}

export function useCharacterImageUsage(project: string) {
  return useQuery({
    queryKey: characterImageUsageQueryKey(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/character-image-usage`, { signal })
        .json<OkResponse<CharacterImageUsage>>(),
    enabled: !!project,
  });
}

export function useUpdateAssetImageSourceSelection(
  project: string,
  kind: AssetImageSourceKind,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (imageSourceSelection: string) =>
      api
        .patch(p`api/v1/projects/${project}/image-source-selection/${kind}`, {
          json: { image_source_selection: imageSourceSelection },
        })
        .json<OkResponse<AssetImageSourceSelection>>(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: assetImageSourceSelectionQueryKey(project, kind),
      });
      if (kind === "character") {
        queryClient.invalidateQueries({
          queryKey: characterImageSelectionQueryKey(project),
        });
      }
    },
  });
}

export function useUpdateCharacterImageSelection(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (characterImageSelection: string) =>
      api
        .patch(p`api/v1/projects/${project}/character-image-selection`, {
          json: { character_image_selection: characterImageSelection },
        })
        .json<OkResponse<CharacterImageSelection>>(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: characterImageSelectionQueryKey(project),
      });
    },
  });
}
