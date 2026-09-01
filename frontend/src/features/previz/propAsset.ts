// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneImage } from '@/api/ops';

import type { PrevizProp } from './domain/scene';

/**
 * 客户端体积上限。后端 multipart 允许 200 MB，但这么大的模型在预演台里解码就要
 * 几秒、显存也扛不住，传完再失望不如现在就说。
 */
export const PREVIZ_PROP_MAX_BYTES = 50 * 1024 * 1024;

const EXTENSION_FORMAT: Record<string, PrevizProp['assetFormat']> = {
  glb: 'glb',
  gltf: 'gltf',
  obj: 'obj',
};

export function detectPropFormat(filename: string): PrevizProp['assetFormat'] | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  // hasOwnProperty 而不是直接索引：`chair.constructor` 这种名字会从原型链上取到一个函数，
  // 于是一个 .constructor 结尾的文件被当成合法模型放行。
  const extension = filename.slice(dot + 1).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(EXTENSION_FORMAT, extension)) return null;
  return EXTENSION_FORMAT[extension] ?? null;
}

export type PrevizPropUpload =
  | { ok: true; assetUrl: string; assetFormat: PrevizProp['assetFormat']; name: string }
  | { ok: false; reason: 'format' | 'too-large' | 'upload' };

/**
 * 把本地模型文件传进 freezone 上传目录并返回可直接给 loader 用的 URL。
 * `uploadFreezoneImage` 的名字是历史遗留——后端那个端点收任意文件，
 * `safe_upload_filename` 只做字符清洗。
 */
export async function uploadPrevizProp(project: string, file: File): Promise<PrevizPropUpload> {
  const assetFormat = detectPropFormat(file.name);
  if (!assetFormat) return { ok: false, reason: 'format' };
  if (file.size > PREVIZ_PROP_MAX_BYTES) return { ok: false, reason: 'too-large' };

  try {
    const uploaded = await uploadFreezoneImage(project, file, file.name);
    return {
      ok: true,
      assetUrl: uploaded.url,
      assetFormat,
      name: file.name.replace(/\.[^.]+$/, ''),
    };
  } catch {
    return { ok: false, reason: 'upload' };
  }
}
