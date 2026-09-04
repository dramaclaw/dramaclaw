// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";
import type {
  ProjectConfig,
  ProjectRole,
  ProjectStatus,
  ProjectSummary,
} from "@/types/project";

const PROJECT_SUMMARIES_STALE_TIME_MS = 5 * 60_000;

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: ({ signal }) =>
      api.get("api/v1/projects", { signal }).json<OkResponse<string[]>>(),
  });
}

export function useProject(project: string) {
  return useQuery({
    queryKey: queryKeys.project(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}`, { signal })
        .json<OkResponse<ProjectConfig>>(),
    enabled: !!project,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api
        .post("api/v1/projects", { json: { name } })
        .json<OkResponse<{ id?: string; project_id?: string; name: string }>>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      queryClient.invalidateQueries({ queryKey: queryKeys.projectSummaries() });
    },
  });
}

export function useUpdateProject(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: Partial<ProjectConfig>) =>
      api
        .patch(p`api/v1/projects/${project}`, { json: config })
        .json<OkResponse<ProjectConfig>>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(project) });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Project summaries + lifecycle (archive / soft-delete / restore / purge).
//
// All state is owned by supertale-be (stored in `project_config.json` per
// project). The frontend fetches summaries in a single call and derives tab
// counts + filters client-side. Mutations hit the matching POST endpoints.
// ─────────────────────────────────────────────────────────────────────────────

type SummaryPayload = {
  id?: string;
  project_id?: string;
  name: string;
  owner_type?: "user" | "team" | null;
  owner_id?: string | null;
  owner_username?: string | null;
  effective_role?: ProjectRole | null;
  home_node_id?: string | null;
  status: ProjectStatus;
  archived_at?: string | null;
  deleted_at?: string | null;
  updated_at?: string | null;
  episode_count?: number | null;
  beat_count?: number | null;
};

function toSummary(p: SummaryPayload): ProjectSummary {
  const id = p.id ?? p.project_id;
  if (!id) {
    throw new Error(`Project summary missing project_id: ${p.name}`);
  }
  return {
    id,
    name: p.name,
    status: p.status,
    ownerType: p.owner_type ?? undefined,
    ownerId: p.owner_id ?? undefined,
    ownerUsername: p.owner_username ?? undefined,
    effectiveRole: p.effective_role ?? undefined,
    homeNodeId: p.home_node_id ?? undefined,
    archivedAt: p.archived_at ?? undefined,
    deletedAt: p.deleted_at ?? undefined,
    updatedAt: p.updated_at ?? undefined,
    episodeCount: p.episode_count ?? undefined,
    beatCount: p.beat_count ?? undefined,
  };
}

export function useAllProjectSummaries(): {
  data: ProjectSummary[] | undefined;
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.projectSummaries(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/projects/summaries", {
          searchParams: { status: "all" },
          signal,
        })
        .json<OkResponse<SummaryPayload[]>>(),
    staleTime: PROJECT_SUMMARIES_STALE_TIME_MS,
  });

  const data = useMemo(
    () => query.data?.data.map(toSummary),
    [query.data],
  );

  return { data, isLoading: query.isLoading };
}

export function useProjectSummaries(status: ProjectStatus): {
  data: ProjectSummary[] | undefined;
  isLoading: boolean;
} {
  const all = useAllProjectSummaries();
  const data = useMemo(
    () => all.data?.filter((p) => p.status === status),
    [all.data, status],
  );
  return { data, isLoading: all.isLoading };
}

export function useProjectCounts(): Record<ProjectStatus, number> {
  const { data } = useAllProjectSummaries();
  return useMemo(() => {
    const counts: Record<ProjectStatus, number> = {
      active: 0,
      archived: 0,
      deleted: 0,
    };
    for (const p of data ?? []) counts[p.status] += 1;
    return counts;
  }, [data]);
}

function useLifecycleMutation(path: "archive" | "unarchive" | "delete" | "restore" | "purge") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api
        .post(p`api/v1/projects/${name}/${path}`)
        .json<OkResponse<SummaryPayload>>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      queryClient.invalidateQueries({ queryKey: queryKeys.projectSummaries() });
    },
  });
}

export const useArchiveProject = () => useLifecycleMutation("archive");
export const useUnarchiveProject = () => useLifecycleMutation("unarchive");
export const useSoftDeleteProject = () => useLifecycleMutation("delete");
export const useRestoreProject = () => useLifecycleMutation("restore");
export const usePurgeProject = () => useLifecycleMutation("purge");

export interface ProjectGrant {
  id: string;
  project_id: string;
  principal_type: "user" | "team";
  principal_id: string;
  principal_username?: string | null;
  role: Exclude<ProjectRole, "owner">;
  created_at?: string | null;
  effective?: boolean;
  inactive_reason?: "principal_access_changed" | null;
}

export interface UserSearchResult {
  id: string;
  username: string;
}

export function useProjectGrants(project: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.projectGrants(project),
    queryFn: ({ signal }) =>
      api
        .get(p`api/v1/projects/${project}/grants`, { signal })
        .json<OkResponse<ProjectGrant[]>>(),
    enabled: enabled && !!project,
  });
}

export function normalizeUserSearchQuery(query: string): string {
  return query.trim().replaceAll("'", "");
}

export function useUserSearch(project: string, query: string) {
  const normalizedQuery = normalizeUserSearchQuery(query);
  return useQuery({
    queryKey: queryKeys.userSearch(project, normalizedQuery),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/users/search", {
          searchParams: { project, q: normalizedQuery },
          signal,
        })
        .json<OkResponse<UserSearchResult[]>>(),
    enabled: Boolean(project) && normalizedQuery.length >= 3,
  });
}

export function useAddProjectGrant(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      principal_username?: string;
      principal_id?: string;
      role: Exclude<ProjectRole, "owner">;
    }) =>
      api
        .post(p`api/v1/projects/${project}/grants`, {
          json: { principal_type: "user", ...payload },
        })
        .json<OkResponse<ProjectGrant>>(),
    // 成员数只有前端在数，数的就是这份名单。这里把刷新 await 掉：不然 mutation
    // 先结束、refetch 还在路上，那个窗口里 isLoading 仍是 false、data 还是加人
    // 之前的旧数量，下一次添加就可能真的越过上限。
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projectGrants(project) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projectSummaries() }),
      ]),
  });
}

export function useUpdateProjectGrant(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ grantId, role }: { grantId: string; role: Exclude<ProjectRole, "owner"> }) =>
      api
        .patch(p`api/v1/projects/${project}/grants/${grantId}`, { json: { role } })
        .json<OkResponse<ProjectGrant>>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectGrants(project) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projectSummaries() });
    },
  });
}

export function useDeleteProjectGrant(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) =>
      api
        .delete(p`api/v1/projects/${project}/grants/${grantId}`)
        .json<OkResponse<{ grant_id: string }>>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectGrants(project) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projectSummaries() });
    },
  });
}
