// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery } from "@tanstack/react-query";
import { listFreezoneCanvases } from "@/api/canvas";
import {
  listFreezoneBeatContext,
  listFreezoneProjectAssets,
} from "@/api/projects";
import {
  fetchFreezoneAssetLibraryFolders,
  fetchFreezoneVideoCharacterLibrary,
} from "@/api/ops";
import { normalizeLibraryList } from "@/features/canvas/ui/assetLibraryItems";
import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";

export type FreezonePresetCanvasRequest =
  | {
      scope: "episode";
      episode: number;
    }
  | {
      scope: "beat";
      episode: number;
      beat: number;
      primary_slot?: "sketch" | "frame" | "render" | string;
    }
  | {
      scope: "asset";
      asset_kind: "character";
      character: string;
    }
  | {
      scope: "asset";
      asset_kind: "portrait";
      character: string;
    }
  | {
      scope: "asset";
      asset_kind: "identity";
      character: string;
      identity_id: string;
    }
  | {
      scope: "asset";
      asset_kind: "prop" | "prop_ref";
      asset_id: string;
    }
  | {
      scope: "asset";
      asset_kind: "scene";
      asset_id: string;
    };

export interface FreezonePresetCanvasData {
  canvas_id: string;
  reused: boolean;
  url: string;
}

export function createFreezonePresetCanvas(project: string, data: FreezonePresetCanvasRequest) {
  return api
    .post(p`api/v1/projects/${project}/freezone/canvases:from-preset`, { json: data })
    .json<OkResponse<FreezonePresetCanvasData>>();
}

export function useCreateFreezonePresetCanvas(project: string) {
  return useMutation({
    mutationFn: (data: FreezonePresetCanvasRequest) =>
      createFreezonePresetCanvas(project, data),
  });
}

export function useFreezoneCanvases(
  project: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: project
      ? queryKeys.freezoneCanvases(project)
      : ["projects", "__missing__", "freezone", "canvases"],
    queryFn: ({ signal }) => {
      if (!project) {
        throw new Error("project is required");
      }
      return listFreezoneCanvases(project, { signal });
    },
    enabled: enabled && Boolean(project),
    staleTime: 15_000,
  });
}

export function useFreezoneProjectAssets(
  project: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: project
      ? queryKeys.freezoneProjectAssets(project)
      : ["projects", "__missing__", "freezone", "assets"],
    queryFn: ({ signal }) => {
      if (!project) {
        throw new Error("project is required");
      }
      return listFreezoneProjectAssets(project, { signal });
    },
    enabled: enabled && Boolean(project),
    staleTime: 15_000,
  });
}

/**
 * 资产库（项目级素材库）的列表。写操作都走裸调用，改完各自 invalidate 这个 key
 * 把列表刷新（AssetLibraryModal 的上传/同步、侧栏条目菜单的改名/删除）。
 */
export function useFreezoneAssetLibrary(
  project: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: project
      ? queryKeys.freezoneAssetLibrary(project)
      : ["projects", "__missing__", "freezone", "asset-library"],
    queryFn: async () => {
      if (!project) {
        throw new Error("project is required");
      }
      return normalizeLibraryList(
        await fetchFreezoneVideoCharacterLibrary(project),
      );
    },
    enabled: enabled && Boolean(project),
    staleTime: 15_000,
  });
}

/**
 * 用户自建的资产库文件夹。系统文件夹（主线 / 待分类资产 / 类目同名目录）不落盘，
 * 由 buildAssetFolders 直接生成，所以这个查询只补自建的那部分。老后端没有该路由
 * 时按空列表处理，浏览侧照常显示系统文件夹。
 */
export function useFreezoneAssetLibraryFolders(
  project: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: project
      ? queryKeys.freezoneAssetLibraryFolders(project)
      : ["projects", "__missing__", "freezone", "asset-library", "folders"],
    queryFn: async () => {
      if (!project) {
        throw new Error("project is required");
      }
      try {
        const folders = await fetchFreezoneAssetLibraryFolders(project);
        return Array.isArray(folders) ? folders : [];
      } catch (err) {
        console.warn("[asset-library] load folders failed, treat as empty", err);
        return [];
      }
    },
    enabled: enabled && Boolean(project),
    staleTime: 15_000,
  });
}

export function useFreezoneBeatContext(
  project: string | null | undefined,
  opts: { episode?: number | null; beat?: number | null } = {},
  enabled = true,
) {
  const episode = typeof opts.episode === "number" ? opts.episode : null;
  const beat = typeof opts.beat === "number" ? opts.beat : null;
  return useQuery({
    queryKey: project
      ? queryKeys.freezoneBeatContext(project, episode, beat)
      : ["projects", "__missing__", "freezone", "beat-context", episode, beat],
    queryFn: ({ signal }) => {
      if (!project) {
        throw new Error("project is required");
      }
      return listFreezoneBeatContext(project, {
        ...(episode !== null ? { episode } : {}),
        ...(beat !== null ? { beat } : {}),
        signal,
      });
    },
    enabled: enabled && Boolean(project),
    staleTime: 15_000,
  });
}
