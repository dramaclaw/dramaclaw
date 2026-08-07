// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useSyncExternalStore } from "react";

import {
  fetchFreezoneVideoModels,
  type FreezoneVideoModelInfo,
} from "@/api/ops";
import { readUrl } from "@/lib/url-params";
import {
  VIDEO_MODELS,
  type ModelOption,
} from "@/features/canvas/ui/ProviderModelPicker";

export interface UseFreezoneVideoModelsResult {
  models: ModelOption[];
  isLoading: boolean;
  isFallback: boolean;
  error: Error | null;
}

// Module-level shared store, mirrors useFreezoneImageModels but keyed under
// a separate namespace so image and video fetches don't collide. One fetch
// per project per tab lifetime.
const states = new Map<string, UseFreezoneVideoModelsResult>();
const listeners = new Map<string, Set<() => void>>();
const inFlightProjects = new Set<string>();
const pendingRefreshProjects = new Set<string>();

// Lazy singleton — circular import with `ProviderModelPicker.tsx` means we
// can't touch `VIDEO_MODELS` at module top level (TDZ).
let noProjectStateMemo: UseFreezoneVideoModelsResult | null = null;
function getNoProjectState(): UseFreezoneVideoModelsResult {
  if (!noProjectStateMemo) {
    noProjectStateMemo = {
      models: VIDEO_MODELS,
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

function writeState(project: string, next: UseFreezoneVideoModelsResult) {
  states.set(project, next);
  emit(project);
}

function toModelOptions(models: FreezoneVideoModelInfo[]): ModelOption[] {
  return models;
}

function ensureLoaded(project: string, force = false) {
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
        models: VIDEO_MODELS,
        isLoading: true,
        isFallback: true,
        error: null,
      });
  fetchFreezoneVideoModels(project)
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
        "[freezone] video models fetch failed, using hardcoded fallback:",
        normalized.message,
      );
      writeState(project, {
        models: VIDEO_MODELS,
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
 * Trigger the shared video-model fetch eagerly for a project. Idempotent —
 * safe to call from FreezoneShell mount alongside the image-model prefetch.
 */
export function prefetchFreezoneVideoModels(project: string): void {
  if (!project) return;
  ensureLoaded(project);
}

function refreshKnownVideoModelCatalogs() {
  const projects = new Set(states.keys());
  const currentProject = readUrl().project;
  if (currentProject) projects.add(currentProject);
  projects.forEach((project) => ensureLoaded(project, true));
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "media-model-catalog-updated",
    refreshKnownVideoModelCatalogs,
  );
  import.meta.hot?.dispose(() => {
    window.removeEventListener(
      "media-model-catalog-updated",
      refreshKnownVideoModelCatalogs,
    );
  });
}

/**
 * 非 hook 的读取口：store / 建边校验这类跑在 React 之外的代码要按当前模型算能力
 * （比如引用上限）时用。读的是同一个 module-level store，所以和组件看到的是同一份
 * 目录；还没加载出来时回落到硬编码的 VIDEO_MODELS，与 hook 的初始状态一致。
 *
 * 不在这里触发 ensureLoaded —— 建边是同步路径，等不到网络回来，而且这个函数会被
 * 高频调用。目录的加载由 FreezoneShell 的 prefetch 和各视频节点的 hook 负责。
 */
export function readFreezoneVideoModels(
  projectOverride?: string | null,
): ModelOption[] {
  const project =
    projectOverride !== undefined ? projectOverride : readUrl().project;
  const state = project ? states.get(project) : undefined;
  return state?.models ?? getNoProjectState().models;
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
 * Read the video model list from a shared module-level store.
 *
 * Mirrors `useFreezoneImageModels` but hits
 * `GET /api/v1/projects/{project}/freezone/video/models`. Failures fall back
 * to hardcoded `VIDEO_MODELS`; a successful empty EE catalog remains empty.
 */
export function useFreezoneVideoModels(
  projectOverride?: string | null,
): UseFreezoneVideoModelsResult {
  const project =
    projectOverride !== undefined ? projectOverride : readUrl().project;

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
