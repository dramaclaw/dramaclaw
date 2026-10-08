// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Reduce backend-provided links to path + query + hash, then re-anchor them onto
 * the project-scoped Freezone tab.
 */
function toPathWithQuery(raw: string): string | null {
  if (raw.startsWith("/")) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function buildFreezoneUrl(relativeOrAbsoluteUrl: string): string | null {
  const raw = relativeOrAbsoluteUrl.trim();
  if (!raw) return null;

  const path = toPathWithQuery(raw);
  if (!path) return null;

  const url = new URL(path, "http://local");
  const projectId = url.searchParams.get("p")?.trim();
  if (!projectId) return null;
  const canvasId = url.searchParams.get("canvas")?.trim();
  const params = new URLSearchParams();
  if (canvasId) params.set("canvas", canvasId);
  const search = params.toString();
  return `/projects/${encodeURIComponent(projectId)}/freezone${search ? `?${search}` : ""}${url.hash}`;
}

/**
 * Project-level entry point into embedded Freezone. Do not pass display names
 * here; backend APIs are scoped by project id.
 */
export function buildFreezoneProjectUrl(projectId: string): string | null {
  const id = projectId.trim();
  if (!id) return null;
  return `/projects/${encodeURIComponent(id)}/freezone`;
}

export function buildFreezoneCanvasUrl(
  projectId: string,
  canvasId: string,
): string | null {
  const projectUrl = buildFreezoneProjectUrl(projectId);
  const id = canvasId.trim();
  if (!projectUrl || !id) return null;
  return `${projectUrl}?canvas=${encodeURIComponent(id)}`;
}

/** Navigate the current tab to the embedded Freezone route. */
export function openFreezoneProject(projectId: string): boolean {
  const url = buildFreezoneProjectUrl(projectId);
  if (!url || typeof window === "undefined") return false;
  window.location.assign(url);
  return true;
}
