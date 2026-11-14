// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { SHARED_MODELS, VIDEO_MODELS, type ModelOption, type ProviderModelDomain } from './modelOptions';

export interface CanvasModelCatalog {
  models: ModelOption[];
  isLoading: boolean;
  isFallback: boolean;
  error: Error | null;
}

export type CanvasModelCatalogs = Record<ProviderModelDomain, ModelOption[]>;

type CatalogProvider = (project?: string | null) => CanvasModelCatalog;
const providers: Partial<Record<ProviderModelDomain, CatalogProvider>> = {};
let scopedCatalogs: CanvasModelCatalogs | undefined;

/** Browser adapters retain ownership of project selection and lazy fetching. */
export function setCanvasModelCatalogProvider(domain: ProviderModelDomain, provider: CatalogProvider): void {
  providers[domain] = provider;
}

function getCatalog(domain: ProviderModelDomain, project?: string | null): CanvasModelCatalog {
  if (scopedCatalogs) {
    return { models: scopedCatalogs[domain], isLoading: false, isFallback: false, error: null };
  }
  const provider = providers[domain];
  return provider ? provider(project) : {
    models: domain === 'image' ? SHARED_MODELS : VIDEO_MODELS,
    isLoading: false,
    isFallback: true,
    error: null,
  };
}

export function getCanvasImageModelCatalog(project?: string | null): CanvasModelCatalog {
  return getCatalog('image', project);
}

export function getCanvasVideoModelCatalog(project?: string | null): CanvasModelCatalog {
  return getCatalog('video', project);
}

/** Catalog overrides cover synchronous command validation and restore on exit. */
export function withCanvasModelCatalogs<T>(
  catalogs: CanvasModelCatalogs,
  fn: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
  const previous = scopedCatalogs;
  scopedCatalogs = catalogs;
  try {
    return fn();
  } finally {
    scopedCatalogs = previous;
  }
}

/** Only for serialized server requests; retain the override across every await. */
export async function withCanvasModelCatalogsAsync<T>(catalogs: CanvasModelCatalogs, fn: () => Promise<T>): Promise<T> {
  const previous = scopedCatalogs;
  scopedCatalogs = catalogs;
  try {
    return await fn();
  } finally {
    scopedCatalogs = previous;
  }
}
