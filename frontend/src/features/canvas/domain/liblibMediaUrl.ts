// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

const LIBLIB_MEDIA_HOST = 'libtv-res.liblib.art';

function withLiblibTransform(source: string | null, transform: string): string | null {
  if (!source) return null;
  try {
    const url = new URL(source);
    if (
      url.protocol !== 'https:' || url.hostname !== LIBLIB_MEDIA_HOST ||
      url.port || url.username || url.password
    ) return null;
    url.searchParams.set('x-oss-process', transform);
    return url.href;
  } catch {
    return null;
  }
}

export function liblibImageThumbnailUrl(source: string | null): string | null {
  return withLiblibTransform(source, 'image/resize,w_320');
}

export function liblibVideoPosterUrl(source: string | null): string | null {
  return withLiblibTransform(source, 'video/snapshot,t_1000,f_jpg,w_320');
}
