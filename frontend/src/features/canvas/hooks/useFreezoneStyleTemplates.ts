// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from "react";

import {
  listFreezoneStyleTemplates,
  type FreezoneStyleTemplate,
} from "@/api/ops";
import { readUrl } from "@/lib/url-params";

export interface UseFreezoneStyleTemplatesResult {
  templates: FreezoneStyleTemplate[];
  assetBase: string;
  isLoading: boolean;
  error: Error | null;
  /**
   * 失败后重来一次。风格直接决定出图效果，不像相机参数那样可有可无，所以这里
   * 比同族 hook 多给一个出口。只在 error 态生效，其余状态调用是空操作 —— 不做
   * 自动重试是因为 ensureLoaded 在 render 里调用，自动重试会变成失败→重渲染→
   * 再失败的死循环。
   */
  retry: () => void;
}

const NOOP_RETRY = () => {};

const EMPTY: UseFreezoneStyleTemplatesResult = {
  templates: [],
  assetBase: "",
  isLoading: false,
  error: null,
  retry: NOOP_RETRY,
};

// Per-project shared store — mirrors useFreezoneImageModels /
// useFreezoneCameraOptions. One fetch per project per tab lifetime.
const states = new Map<string, UseFreezoneStyleTemplatesResult>();
const listeners = new Map<string, Set<() => void>>();

function emit(project: string) {
  listeners.get(project)?.forEach((fn) => fn());
}

function writeState(project: string, next: UseFreezoneStyleTemplatesResult) {
  states.set(project, next);
  emit(project);
}

// 起飞时故意只 states.set 不 emit：ensureLoaded 会在 render 阶段被调用，那时
// 通知订阅者等于在渲染别的组件时改它的 state。手工重试不在 render 里，可以 emit。
function startFetch(project: string) {
  states.set(project, {
    templates: [],
    assetBase: "",
    isLoading: true,
    error: null,
    retry: NOOP_RETRY,
  });
  listFreezoneStyleTemplates(project)
    .then(({ templates, assetBase }) => {
      writeState(project, {
        templates,
        assetBase,
        isLoading: false,
        error: null,
        retry: NOOP_RETRY,
      });
    })
    .catch((error: unknown) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      console.warn(
        "[freezone] style-templates fetch failed:",
        normalized.message,
      );
      writeState(project, {
        templates: [],
        assetBase: "",
        isLoading: false,
        error: normalized,
        retry: () => retryLoad(project),
      });
    });
}

function retryLoad(project: string) {
  const current = states.get(project);
  if (!current || current.isLoading || !current.error) return;
  startFetch(project);
  emit(project);
}

function ensureLoaded(project: string) {
  if (states.has(project)) return;
  startFetch(project);
}

export function prefetchFreezoneStyleTemplates(project: string): void {
  if (!project) return;
  ensureLoaded(project);
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

export function useFreezoneStyleTemplates(
  projectOverride?: string | null,
): UseFreezoneStyleTemplatesResult {
  const project =
    projectOverride !== undefined ? projectOverride : readUrl().project;

  if (project) ensureLoaded(project);

  return useSyncExternalStore(
    (callback) => subscribe(project ?? null, callback),
    () => (project ? states.get(project) ?? EMPTY : EMPTY),
    () => EMPTY,
  );
}
