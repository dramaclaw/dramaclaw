// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

interface MediaViewerSession {
  isOpen: boolean;
  sessionId: number;
  currentIndex: number;
}

export interface ImageViewerState extends MediaViewerSession {
  currentImageUrl: string | null;
  imageList: string[];
}

export interface VideoViewerState extends MediaViewerSession {
  videoUrl: string;
  videoList: string[];
  title?: string;
}

export function closedImageViewer(sessionId = 0): ImageViewerState {
  return { isOpen: false, sessionId, currentImageUrl: null, imageList: [], currentIndex: 0 };
}

export function closedVideoViewer(sessionId = 0): VideoViewerState {
  return { isOpen: false, sessionId, videoUrl: '', videoList: [], currentIndex: 0 };
}

/** Keep the supplied order, with the selected original always represented. */
export function mediaViewerUrls(currentUrl: string, urls: Array<string | null | undefined>): string[] {
  const list = [...new Set(urls
    .filter((url): url is string => typeof url === 'string' && Boolean(url.trim()))
    .map(url => url.trim()))];
  const current = currentUrl.trim();
  if (current && !list.includes(current)) list.unshift(current);
  return list;
}
