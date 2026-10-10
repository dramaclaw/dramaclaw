// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/** 与后端 `freezone/image-to-blockout` 路由接受的后缀一致；改一处要改两处。 */
export const PREVIZ_BLOCKOUT_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
/** 只是省一次白传：图片送模型前后端会压到长边 1280，再大也不会更准。 */
export const PREVIZ_BLOCKOUT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const PREVIZ_BLOCKOUT_MIN_SHORT_EDGE = 512;
export const PREVIZ_BLOCKOUT_MAX_ASPECT = 2.5;
/** 与后端 `FreezoneImageToBlockoutRequest.description` 的上限一致。 */
export const PREVIZ_BLOCKOUT_DESCRIPTION_MAX_CHARS = 2000;

export type PrevizBlockoutImageVerdict = 'ok' | 'extension' | 'size';

/**
 * 只提示、不拦截的那一层：这些图照样能生成，只是效果多半不好。
 * 格式和体积是另一回事（`isAcceptedBlockoutImage`），那两项后端根本不收。
 */
export type PrevizBlockoutImageHint = 'small' | 'wide' | 'tall' | 'unreadable';

export interface PrevizImageSize {
  width: number;
  height: number;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isAcceptedBlockoutImage(name: string, bytes: number): PrevizBlockoutImageVerdict {
  if (!(PREVIZ_BLOCKOUT_IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(name))) {
    return 'extension';
  }
  if (!(bytes > 0) || bytes > PREVIZ_BLOCKOUT_MAX_IMAGE_BYTES) return 'size';
  return 'ok';
}

/** 上传用的后缀；调用前先过 `isAcceptedBlockoutImage`。 */
export function blockoutImageExtension(name: string): string {
  return extensionOf(name);
}

export function blockoutImageHints(size: PrevizImageSize | null): PrevizBlockoutImageHint[] {
  // 浏览器量不出尺寸（改了后缀的 HEIC、传坏的文件）：后端多半也读不了，先说一声，但不拦。
  if (!size) return ['unreadable'];
  const { width, height } = size;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return ['unreadable'];
  }
  const hints: PrevizBlockoutImageHint[] = [];
  if (Math.min(width, height) < PREVIZ_BLOCKOUT_MIN_SHORT_EDGE) hints.push('small');
  if (width / height > PREVIZ_BLOCKOUT_MAX_ASPECT) hints.push('wide');
  if (height / width > PREVIZ_BLOCKOUT_MAX_ASPECT) hints.push('tall');
  return hints;
}
