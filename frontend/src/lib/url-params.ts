// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Parse + push freezone URL params for /projects/<project_id>/freezone?canvas=<id>.
// Mutating these routes through tanstack-router when it is registered (see
// getAppRouter). Falling back to the raw History API is only for non-router
// contexts (unit tests, pre-mount).

import { getAppRouter } from "@/lib/app-router";

export interface FreezoneUrl {
  /** SuperTale project_id. Display names are not accepted by project-scoped APIs. */
  project: string | null;
  canvas: string | null;
}

export interface WriteUrlOptions {
  replace?: boolean;
  notify?: boolean;
}

const LAST_CANVAS_PREFIX = "supertale.freezone.lastCanvas.";

function projectFromPathname(pathname = window.location.pathname): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)\/freezone(?:\/|$)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function canvasFromRouterSearch(router: NonNullable<ReturnType<typeof getAppRouter>>): string | null {
  const canvas = (router.state.location.search as { canvas?: unknown }).canvas;
  return typeof canvas === "string" && canvas.length > 0 ? canvas : null;
}

export function readUrl(): FreezoneUrl {
  const params = new URLSearchParams(window.location.search);
  return {
    project: projectFromPathname() ?? params.get("p"),
    canvas: params.get("canvas"),
  };
}

export function writeUrl(next: Partial<FreezoneUrl>, options: WriteUrlOptions = {}) {
  const router = getAppRouter();
  // When the router is registered it — not window.location — is the source of
  // truth for "where are we". tanstack throttles its navigations onto a
  // microtask, so window.location LAGS a pending navigation: while the user is
  // leaving Freezone the router already reads /characters but window.location
  // still reads /freezone. Guarding on the stale window.location would let a
  // stray canvas-sync write here navigate the user BACK to Freezone, trapping
  // them on 虾画. Read the pathname/canvas from the router so a write that
  // fires after the route has moved off Freezone simply no-ops.
  const currentPathname = router?.state.location.pathname;
  const pathProject = currentPathname
    ? projectFromPathname(currentPathname)
    : projectFromPathname();
  if (!pathProject) return;

  const current: FreezoneUrl = router
    ? { project: pathProject, canvas: canvasFromRouterSearch(router) }
    : readUrl();
  // 显式区分"未传"和"传 null"：?? 会把 null 当作回退到 current，导致
  // writeUrl({ project: null }) 这种"清空字段"的语义失效（例如返回项目列表）。
  const merged: FreezoneUrl = {
    project: "project" in next ? next.project ?? null : current.project,
    canvas: "canvas" in next ? next.canvas ?? null : current.canvas,
  };
  if (router) {
    // Route THROUGH tanstack so this navigation joins the router's throttled
    // history queue and router state stays consistent. Mutating window.history
    // directly (the fallback below) races with that queue: window.location lags
    // a pending navigation, so a raw write + synthetic popstate can leave the
    // URL and the rendered route out of sync (navigate to /ingest but still
    // render the canvas).
    router.navigate({
      to: merged.project
        ? "/projects/$project/freezone"
        : "/projects/$project/ingest",
      params: { project: pathProject },
      search: merged.canvas ? { canvas: merged.canvas } : {},
      replace: options.replace ?? false,
      resetScroll: false,
    });
    return;
  }

  const params = new URLSearchParams();
  if (merged.canvas) params.set("canvas", merged.canvas);
  const search = params.toString();
  const pathname =
    pathProject && merged.project
      ? `/projects/${encodeURIComponent(merged.project)}/freezone`
      : `/projects/${encodeURIComponent(pathProject)}/ingest`;
  const newUrl = `${pathname}${search ? `?${search}` : ""}`;
  if (options.replace) {
    window.history.replaceState({}, "", newUrl);
  } else {
    window.history.pushState({}, "", newUrl);
  }
  if (options.notify !== false) {
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

export function readLastCanvas(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  try {
    const value = window.localStorage.getItem(`${LAST_CANVAS_PREFIX}${projectId}`);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function rememberLastCanvas(projectId: string | null | undefined, canvasId: string): void {
  if (!projectId || !canvasId) return;
  try {
    window.localStorage.setItem(`${LAST_CANVAS_PREFIX}${projectId}`, canvasId);
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

export function useUrlParam<K extends keyof FreezoneUrl>(_key: K): FreezoneUrl[K] {
  // Lightweight non-hook helper for places that want a synchronous read.
  return readUrl()[_key];
}
