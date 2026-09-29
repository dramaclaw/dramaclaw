// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { localizeLiblibCanvasAssets } from '@/api/canvas';
import { ApiError } from '@/api/client';
import { BackendStatusError } from '@/lib/api-errors';
import { applyLocalizedAssets, collectRemoteMediaUrls } from '@/features/canvas/domain/canvasRemoteMedia';
import { useCanvasStore } from '@/stores/canvasStore';

// Small requests let each completed batch be saved while the canvas stays editable.
export const LIBLIB_LOCALIZE_BATCH_SIZE = 4;

export interface LocalizationProgress {
  completed: number;
  total: number;
  done: number;
  failed: number;
}

export async function localizeLiblibCanvasInBackground(options: {
  project: string;
  sourceProjectId: string | null;
  isActive: () => boolean;
  onProgress: (progress: LocalizationProgress) => void;
  save: () => Promise<void>;
}): Promise<LocalizationProgress | null> {
  const urls = collectRemoteMediaUrls(useCanvasStore.getState().nodes);
  const progress: LocalizationProgress = { completed: 0, total: urls.length, done: 0, failed: 0 };
  options.onProgress({ ...progress });
  for (let start = 0; start < urls.length; start += LIBLIB_LOCALIZE_BATCH_SIZE) {
    if (!options.isActive()) return null;
    const batch = urls.slice(start, start + LIBLIB_LOCALIZE_BATCH_SIZE);
    let assetMap: Record<string, string> = {};
    let reasons = new Map<string, string>();
    try {
      const response = await localizeLiblibCanvasAssets(options.project, batch, options.sourceProjectId);
      assetMap = response.assetMap;
      reasons = new Map(response.skippedMedia.map((item) => [item.url, item.reason]));
    } catch (error) {
      if ((error instanceof ApiError || error instanceof BackendStatusError)
        && [401, 403, 404].includes(error.status)) throw error;
      // One failed batch must not discard earlier progress or block the next batch.
      reasons = new Map(batch.map((url) => [url, 'liblib_media_unavailable']));
    }
    if (!options.isActive()) return null;
    for (const node of useCanvasStore.getState().nodes) {
      // Read the live graph after the request: edits/deletions made during a download win.
      const next = applyLocalizedAssets(node.data, assetMap, reasons);
      if (next) useCanvasStore.getState().updateNodeData(node.id, next);
    }
    await options.save();
    if (!options.isActive()) return null;
    progress.completed += batch.length;
    progress.done += batch.filter((url) => Boolean(assetMap[url])).length;
    progress.failed = progress.completed - progress.done;
    options.onProgress({ ...progress });
  }
  return progress;
}
