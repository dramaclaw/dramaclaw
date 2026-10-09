// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fetchNodeGenerationHistory, type FreezoneGenerationHistoryRecord } from '@/api/ops';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import { historyRecordOutputUrl, isCompletedGeneration } from '../domain/generationHistory';
import { mediaViewerUrls } from '../domain/mediaViewerState';

type MediaType = 'image' | 'video';
type ViewerUrls = Array<string | null | undefined>;

export function nodeMediaViewerUrls(
  currentUrl: string,
  urls: ViewerUrls = [],
  records: FreezoneGenerationHistoryRecord[] = [],
  mediaType: MediaType = 'image',
): string[] {
  const history = records
    .filter(record => record.media_type === mediaType && isCompletedGeneration(record))
    .sort((a, b) => (Date.parse(b.recorded_at) || 0) - (Date.parse(a.recorded_at) || 0))
    .map(historyRecordOutputUrl);
  return mediaViewerUrls(currentUrl, [currentUrl, ...urls, ...history]);
}

/** Open immediately; history may arrive after navigation within the same session. */
export async function openNodeMediaViewer(
  mediaType: MediaType,
  url: string,
  nodeId?: string,
  urls: ViewerUrls = [],
  title?: string,
): Promise<void> {
  const source = url.trim();
  if (!source) return;
  const list = nodeMediaViewerUrls(source, urls, [], mediaType);
  const store = useCanvasStore.getState();
  if (mediaType === 'image') {
    store.openImageViewer(source, list);
  } else {
    if (nodeId) {
      const node = [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
        .find(element => element.dataset.id === nodeId);
      node?.querySelector('video')?.pause();
    }
    store.openVideoViewer(source, list, title);
  }
  const opened = useCanvasStore.getState();
  const sessionId = mediaType === 'image' ? opened.imageViewer.sessionId : opened.videoViewer.sessionId;
  const context = readUrl();
  if (!nodeId || !context.project) return;

  const canvasId = context.canvas ?? 'default';
  let records: FreezoneGenerationHistoryRecord[];
  try {
    records = await fetchNodeGenerationHistory(context.project, canvasId, nodeId, 100);
  } catch {
    // The current media and local batch remain usable if history is unavailable.
    return;
  }
  const currentContext = readUrl();
  if (currentContext.project !== context.project || (currentContext.canvas ?? 'default') !== canvasId) return;
  const items = nodeMediaViewerUrls(source, urls, records, mediaType);
  const current = useCanvasStore.getState();
  if (mediaType === 'image') current.updateImageViewerHistory(sessionId, items);
  else current.updateVideoViewerHistory(sessionId, items);
}

export function openNodeImageViewer(url: string, nodeId?: string, urls: ViewerUrls = []): Promise<void> {
  return openNodeMediaViewer('image', url, nodeId, urls);
}

export function openNodeVideoViewer(url: string, nodeId?: string, urls: ViewerUrls = [], title?: string): Promise<void> {
  return openNodeMediaViewer('video', url, nodeId, urls, title);
}

export function nodeImageViewerUrls(currentUrl: string, urls: ViewerUrls = [], records: FreezoneGenerationHistoryRecord[] = []): string[] {
  return nodeMediaViewerUrls(currentUrl, urls, records, 'image');
}
