// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiCall } from "@/api/client";

export type FreezoneAgentConfigKind = "skills" | "recipes";
export type FreezoneAgentConfigPayload = Record<string, unknown> & { id?: string };
export type FreezoneAgentBundlePayload = Record<string, unknown> & {
  id?: string;
  skill?: FreezoneAgentConfigPayload;
  recipes?: FreezoneAgentConfigPayload[];
};

export interface FreezoneAgentBundleValidationResult {
  bundle_id: string;
  skill_count: number;
  recipe_count: number;
  warnings: string[];
}

export interface FreezoneAgentBundleInstallResult {
  bundle_id: string;
  installed_skill: string;
  installed_recipes: string[];
}

export interface FreezoneCommunityCatalogItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  min_dramaclaw_version: string;
  tags: string[];
  bundle_url: string;
  cover_url?: string;
}

export const freezoneAgentConfigQueryKey = (kind: FreezoneAgentConfigKind) => [
  "freezone-agent-config",
  kind,
];

export function useFreezoneAgentConfigItems(kind: FreezoneAgentConfigKind) {
  return useQuery({
    queryKey: freezoneAgentConfigQueryKey(kind),
    queryFn: () =>
      apiCall<FreezoneAgentConfigPayload[]>(`freezone/agent-config/${kind}`),
  });
}

export function useSaveFreezoneAgentConfigItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      kind,
      payload,
    }: {
      kind: FreezoneAgentConfigKind;
      payload: FreezoneAgentConfigPayload;
    }) =>
      apiCall<FreezoneAgentConfigPayload>(`freezone/agent-config/${kind}`, {
        method: "POST",
        json: payload,
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: freezoneAgentConfigQueryKey(variables.kind),
      });
    },
  });
}

export function useDeleteFreezoneAgentConfigItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      kind,
    }: {
      id: string;
      kind: FreezoneAgentConfigKind;
    }) =>
      apiCall<{ deleted: boolean }>(
        `freezone/agent-config/${kind}/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: freezoneAgentConfigQueryKey(variables.kind),
      });
    },
  });
}

export function useValidateFreezoneAgentBundle() {
  return useMutation({
    mutationFn: ({ bundle }: { bundle: FreezoneAgentBundlePayload }) =>
      apiCall<FreezoneAgentBundleValidationResult>(
        "freezone/agent-config/bundles:validate",
        {
          method: "POST",
          json: { bundle },
        },
      ),
  });
}

export function useInstallFreezoneAgentBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bundle }: { bundle: FreezoneAgentBundlePayload }) =>
      apiCall<FreezoneAgentBundleInstallResult>(
        "freezone/agent-config/bundles:install",
        {
          method: "POST",
          json: { bundle },
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: freezoneAgentConfigQueryKey("skills"),
      });
      void queryClient.invalidateQueries({
        queryKey: freezoneAgentConfigQueryKey("recipes"),
      });
    },
  });
}

export function useExportFreezoneAgentBundle() {
  return useMutation({
    mutationFn: ({
      bundle,
      skillId,
    }: {
      bundle: Record<string, unknown>;
      skillId: string;
    }) =>
      apiCall<FreezoneAgentBundlePayload>(
        "freezone/agent-config/bundles:export",
        {
          method: "POST",
          json: {
            skill_id: skillId,
            bundle,
            include_recipes: true,
          },
        },
      ),
  });
}
