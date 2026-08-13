// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useSyncExternalStore } from "react";

import {
  fetchFreezoneImageModels,
  type FreezoneImageModelInfo,
} from "@/api/ops";
import { readUrl } from "@/lib/url-params";
import {
  SHARED_MODELS,
  type ModelOption,
} from "@/features/canvas/ui/ProviderModelPicker";

export interface UseFreezoneImageModelsResult {
  models: ModelOption[];
  isLoading: boolean;
  isFallback: boolean;
  error: Error | null;
}

// Module-level shared store. One state snapshot per project, one fetch per
// project per tab lifetime. Every consumer reads the same reference via
// useSyncExternalStore, so a freshly mounted picker sees the cached result
// immediately (no per-component re-fetch, no loading flicker).
const states = new Map<string, UseFreezoneImageModelsResult>();
const listeners = new Map<string, Set<() => void>>();
const inFlightProjects = new Set<string>();
const pendingRefreshProjects = new Set<string>();

// Lazy singleton — must NOT touch `SHARED_MODELS` at module top level
// because we have a circular import with `ProviderModelPicker.tsx` (the
// picker imports this hook). Reading SHARED_MODELS during this module's
// top-level evaluation would hit a TDZ. Reading it lazily inside a
// function dodges that.
let noProjectStateMemo: UseFreezoneImageModelsResult | null = null;
function getNoProjectState(): UseFreezoneImageModelsResult {
  if (!noProjectStateMemo) {
    noProjectStateMemo = {
      models: SHARED_MODELS,
      isLoading: false,
      isFallback: true,
      error: null,
    };
  }
  return noProjectStateMemo;
}

function emit(project: string) {
  listeners.get(project)?.forEach((fn) => fn());
}

function writeState(project: string, next: UseFreezoneImageModelsResult) {
  states.set(project, next);
  emit(project);
}

function toModelOptions(models: FreezoneImageModelInfo[]): ModelOption[] {
  return models;
}

function ensureLoaded(project: string, force = false) {
  // Already loaded or in-flight — `states` is populated synchronously on
  // first call so this is a true idempotent guard.
  if (inFlightProjects.has(project)) {
    if (force) pendingRefreshProjects.add(project);
    return;
  }
  if (!force && states.has(project)) return;
  inFlightProjects.add(project);
  const current = states.get(project);
  states.set(project, current
    ? { ...current, isLoading: true, error: null }
    : {
        models: SHARED_MODELS,
        isLoading: true,
        isFallback: true,
        error: null,
      });
  fetchFreezoneImageModels(project)
    .then((models) => {
      writeState(project, {
        models: toModelOptions(models),
        isLoading: false,
        isFallback: false,
        error: null,
      });
    })
    .catch((error: unknown) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      console.warn(
        "[freezone] image models fetch failed, using hardcoded fallback:",
        normalized.message,
      );
      writeState(project, {
        models: SHARED_MODELS,
        isLoading: false,
        isFallback: true,
        error: normalized,
      });
    })
    .finally(() => {
      inFlightProjects.delete(project);
      if (pendingRefreshProjects.delete(project)) ensureLoaded(project, true);
    });
}

/**
 * Trigger the shared model fetch eagerly for a project. Idempotent — safe
 * to call from a root-level useEffect (e.g. FreezoneShell mount) so the
 * request is in-flight before any picker / panel mounts. Subsequent picker
 * renders read straight from the populated store.
 */
export function prefetchFreezoneImageModels(project: string): void {
  if (!project) return;
  ensureLoaded(project);
}

function refreshKnownImageModelCatalogs() {
  const projects = new Set(states.keys());
  const currentProject = readUrl().project;
  if (currentProject) projects.add(currentProject);
  projects.forEach((project) => ensureLoaded(project, true));
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "media-model-catalog-updated",
    refreshKnownImageModelCatalogs,
  );
  import.meta.hot?.dispose(() => {
    window.removeEventListener(
      "media-model-catalog-updated",
      refreshKnownImageModelCatalogs,
    );
  });
}

function subscribe(project: string | null, callback: () => void) {
  if (!project) return () => {};
  let bucket = listeners.get(project);
  if (!bucket) {
    bucket = new Set();
    listeners.set(project, bucket);
  }
  bucket.add(callback);
  return () => {
    bucket!.delete(callback);
    if (bucket!.size === 0) listeners.delete(project);
  };
}

/**
 * Read the image model list from a shared module-level store.
 *
 * The first call for a given `project` triggers
 * `GET /api/v1/projects/{project}/freezone/image/models`. All subsequent
 * consumers (any picker on any panel) read the same cached snapshot and
 * re-render together when the fetch resolves. Failures fall back to the
 * hardcoded `SHARED_MODELS`; a successful empty EE catalog remains empty.
 *
 * Returning focus to the tab refreshes the catalog so Admin changes become
 * visible without rebuilding the canvas.
 */
export function useFreezoneImageModels(
  projectOverride?: string | null,
): UseFreezoneImageModelsResult {
  const project =
    projectOverride !== undefined ? projectOverride : readUrl().project;

  // Kick off the shared fetch on first read. Idempotent thereafter.
  if (project) ensureLoaded(project);

  useEffect(() => {
    if (!project) return;
    const refresh = () => ensureLoaded(project, true);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [project]);

  return useSyncExternalStore(
    (callback) => subscribe(project ?? null, callback),
    () =>
      project ? states.get(project) ?? getNoProjectState() : getNoProjectState(),
    () => getNoProjectState(),
  );
}

/**
 * 后台**确实**一个模型都没配（接口成功返回空列表），不是拉取失败兜底、
 * 也不是还在加载。
 *
 * 为 true 时调用方必须禁用提交：后端 `_resolve_catalog_request` 对权威空目录
 * 直接 409，让用户拿一个前端硬编码的模型点下去再收一个报错是最糟的体验。
 * 三个状态必须一起看 —— 只判 `models.length === 0` 会把「还在加载」也算成
 * 「没配」，面板会闪一下不可用。
 *
 * 只吃 models/isLoading/isFallback 三个字段，`useFreezoneVideoModels` 的返回值
 * 形状相同，视频目录也用这一条判据。
 */
export function isAuthoritativeEmptyCatalog(
  result: Pick<UseFreezoneImageModelsResult, "models" | "isLoading" | "isFallback">,
): boolean {
  return !result.isLoading && !result.isFallback && result.models.length === 0;
}
