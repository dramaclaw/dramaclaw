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
}

const EMPTY: UseFreezoneStyleTemplatesResult = {
  templates: [],
  assetBase: "",
  isLoading: false,
  error: null,
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

function ensureLoaded(project: string) {
  if (states.has(project)) return;
  states.set(project, { templates: [], assetBase: "", isLoading: true, error: null });
  listFreezoneStyleTemplates(project)
    .then(({ templates, assetBase }) => {
      writeState(project, { templates, assetBase, isLoading: false, error: null });
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
      });
    });
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
