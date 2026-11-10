// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneImage } from '@/api/ops';
import { dataUrlToBlob } from './imageData';
import { readUrl } from '@/lib/url-params';

/**
 * Locally-produced images (crop / annotate / split frames / 360 captures /
 * storyboard exports) start life as data URLs or local file paths. Persist them
 * to the freezone backend so the node holds an address that survives saving.
 *
 * Throws if there's no project in the URL or the upload fails, so the caller
 * can report the failure to the user.
 */
export async function uploadLocalImageToBackend(
  localImageUrl: string,
  filename: string
): Promise<string> {
  const trimmed = localImageUrl?.trim();
  if (!trimmed) {
    return localImageUrl;
  }
  // Already a remote URL — nothing to upload.
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const projectId = readUrl().project;
  if (!projectId) {
    throw new Error('no project to upload the image to');
  }

  // CSP `connect-src 'self'` blocks `fetch('data:...')` in production, so
  // decode data URLs directly instead of fetching them. Other (same-origin)
  // local paths still go through fetch.
  let blob: Blob;
  if (trimmed.startsWith('data:')) {
    blob = dataUrlToBlob(trimmed);
  } else {
    const resp = await fetch(trimmed);
    if (!resp.ok) {
      throw new Error(`fetch local image failed: ${resp.status}`);
    }
    blob = await resp.blob();
  }
  const uploaded = await uploadFreezoneImage(projectId, blob, filename);
  return uploaded.url;
}
