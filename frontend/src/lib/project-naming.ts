// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { api } from "@/lib/api";
import type { OkResponse } from "@/types/api";
import { listFreezoneCanvases } from "@/api/canvas";
import { parseLiblibShareUrl } from "@/features/freezone/liblibCanvasImport";

export const PROJECT_NAME_MAX_LENGTH = 64;
const INVALID_NAME_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f\u007f]/;

export function getProjectNameValidationKey(name: string): string | null {
  if (Array.from(name).length > PROJECT_NAME_MAX_LENGTH) return "project.nameTooLong";
  return !name.trim() || name !== name.trim() || name.startsWith("_")
    || name === "." || name === ".." || INVALID_NAME_CHARACTERS.test(name)
    ? "project.nameInvalid" : null;
}

export async function previewLiblibProject(shareUrl: string, signal?: AbortSignal) {
  const share = parseLiblibShareUrl(shareUrl);
  const result = await api.post("api/v1/projects/liblib-preview", {
    json: { share_url: share.shareUrl }, signal, retry: 0,
  }).json<OkResponse<{ name: string; source_url: string }>>();
  return result.data;
}

export async function renameProject(projectId: string, name: string) {
  return api.post(`api/v1/projects/${encodeURIComponent(projectId)}/rename`, {
    json: { name },
  }).json<OkResponse<{ id: string; name: string }>>();
}

export type ProjectImportSource = { canvasId: string; name: string; url: string };

export async function listProjectImportSources(projectId: string, signal?: AbortSignal): Promise<ProjectImportSource[]> {
  const canvases = await listFreezoneCanvases(projectId, { signal });
  return canvases.flatMap((canvas) => {
    const meta = canvas.metadata;
    const source = meta?.liblib_import as Record<string, unknown> | undefined;
    if (!source || typeof source.source_url !== "string") return [];
    try {
      const share = parseLiblibShareUrl(source.source_url);
      const name = source.source_name ?? meta?.display_name;
      return [{ canvasId: canvas.id, name: typeof name === "string" ? name : "", url: share.shareUrl }];
    } catch {
      return [];
    }
  });
}
