// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneImage } from '@/api/ops';

import type { PrevizProp } from './domain/scene';
import { compressPrevizProp, type PrevizPropRepack } from './propCompress';

const BYTES_PER_MB = 1024 * 1024;

/**
 * 后端给 `/freezone/upload` 这个 multipart 路由放行的请求体上限，和 Python 侧的
 * `MAX_PROJECT_UPLOAD_BYTES`（`utils/upload_safety.py`）是同一个数。超了由
 * `api/app.py` 的 `_request_body_limit` 直接 413，请求进不到处理函数里。
 *
 * **别拿去别处复用**：那个函数只对以 `/upload`、`/reference-file-upload` 结尾的
 * multipart 请求放宽到这个数，其余路由一律 5 MB。
 */
const PROJECT_UPLOAD_BODY_LIMIT_BYTES = 200 * BYTES_PER_MB;

/**
 * 留给 multipart 封装的余量：boundary、`Content-Disposition` 里的文件名、表单头。
 * 实测只有几百字节，1 MB 是拍出来的富余。
 *
 * 有这一段是因为后端卡的是**整个请求体**而不是文件本身：按文件大小卡到 200 MB 整的话，
 * 一个正好 200 MB 的文件连着 boundary 一起就超了，会在服务端被 413 拒掉——而那时用户
 * 已经把整个文件传完了。宁可提前几百字节说不行。
 */
const MULTIPART_HEADROOM_BYTES = BYTES_PER_MB;

/**
 * 客户端体积上限。
 *
 * 曾经是 50 MB，理由是「这么大的模型在预演台里解码就要几秒、显存也扛不住」。那条理由
 * 站不住：文件大小量不准这两样开销。一个 80 MB、贴图 4K 的建筑扫描件和一个 80 MB、
 * 几十万面的雕塑，解码时间和显存差着数量级；而 50 MB 这条线挡掉的，恰恰是最常见的那
 * 一类——带贴图的整栋建筑。挡的时机还特别早，用户连试都试不了。真扛不住的是加载环节，
 * 那里该给的是进度和失败提示，不是提前一刀切。
 *
 * 现在这条线只剩一个意思：**再往上传后端也会拒**。它不再是性能判断，所以不要在这里
 * 「顺手调小一点更保险」——调小等于凭空发明一个后端并不存在的限制。
 */
export const PREVIZ_PROP_MAX_BYTES = PROJECT_UPLOAD_BODY_LIMIT_BYTES - MULTIPART_HEADROOM_BYTES;

/** 提示文案里的上限，整数 MB。 */
export const PREVIZ_PROP_MAX_MB = Math.floor(PREVIZ_PROP_MAX_BYTES / BYTES_PER_MB);

/**
 * 提示文案里的文件体积，整数 MB。
 *
 * **向上取整**，而上限是向下取整：两个方向都朝着「不撒谎」的一边靠，于是被拒文件的
 * 显示体积必然严格大于显示上限。都用同一种取整的话，只超出几百字节的文件会说出
 * 「模型 199 MB，超过 199 MB 上限」这种自相矛盾的话。
 */
export function propSizeMb(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_MB);
}

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
  | {
      ok: true;
      assetUrl: string;
      assetFormat: PrevizProp['assetFormat'];
      name: string;
      /** 压之前的字节数，与 `bytes` 相等就表示这一趟没压动。 */
      originalBytes: number;
      /** 真正传上去的字节数。 */
      bytes: number;
    }
  | { ok: false; reason: 'format' | 'upload' }
  // 体积带上原始字节数：提示里要说清「你这个多大」，否则用户只知道超了，不知道超多少，
  // 也就不知道该减面还是压贴图、要减到什么程度。
  | { ok: false; reason: 'too-large'; size: number };

export interface PrevizPropUploadOptions {
  /**
   * 在本地校验全部通过、真正发出请求之前调一次。
   *
   * 之所以做成钩子而不是让调用方自己先校验一遍：格式或体积不合规的文件根本不会上网，
   * 给它弹一个「正在上传」再立刻换成错误，用户看到的是一次闪烁。把时机留在函数内部，
   * 「什么算合规」就只有这一处答案。
   */
  onUploadStart?: () => void;
  /**
   * 真的要压缩了才调一次。压缩要把整个文件解出来，几百兆的模型上要几秒到十几秒，
   * 不说一声的话界面看着像卡死了。
   */
  onCompressStart?: () => void;
  /** 测试用的缝，一路透传给 `compressPrevizProp`。 */
  repack?: PrevizPropRepack;
}

/**
 * 把本地模型文件传进 freezone 上传目录并返回可直接给 loader 用的 URL。
 * `uploadFreezoneImage` 的名字是历史遗留——后端那个端点收任意文件，
 * `safe_upload_filename` 只做字符清洗。
 */
export async function uploadPrevizProp(
  project: string,
  file: File,
  options?: PrevizPropUploadOptions,
): Promise<PrevizPropUpload> {
  const assetFormat = detectPropFormat(file.name);
  if (!assetFormat) return { ok: false, reason: 'format' };

  // 体积检查压在压缩**之后**：一份 4K 贴图的建筑常常压完只剩零头，先按原始体积一刀
  // 切掉的话，用户被拒的正是那些最该压、也最压得动的文件。代价是超限文件也要先解一遍
  // 才知道拒——那点本地开销买的是「本来能过的现在过得去」。
  const packed = await compressPrevizProp(file, assetFormat, {
    onCompressStart: options?.onCompressStart,
    repack: options?.repack,
  });
  if (packed.file.size > PREVIZ_PROP_MAX_BYTES) {
    return { ok: false, reason: 'too-large', size: packed.file.size };
  }

  options?.onUploadStart?.();
  try {
    const uploaded = await uploadFreezoneImage(project, packed.file, packed.file.name);
    return {
      ok: true,
      assetUrl: uploaded.url,
      assetFormat: packed.format,
      // 名字取自**用户挑的那个文件**，不是压完那个：压缩会把 .gltf 改写成 .glb，
      // 大纲里跟着变成另一个名字的话，用户会以为自己传错了文件。
      name: file.name.replace(/\.[^.]+$/, ''),
      originalBytes: packed.originalBytes,
      bytes: packed.file.size,
    };
  } catch {
    return { ok: false, reason: 'upload' };
  }
}
