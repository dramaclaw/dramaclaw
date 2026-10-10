// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PrevizProp } from './domain/scene';
import { repackGlb } from './propRepack';

/**
 * 上传前在浏览器里把模型压小。
 *
 * **压缩放在前端，不放后端。** 后端那条路要装一套 gltf 工具链、要为几百兆的临时文件
 * 备磁盘、还要排队——而这活儿本来就发生在用户已经把整个文件读进内存的那台机器上。
 * 更要紧的是省的那一趟：压缩发生在上传**之前**，一份 180 MB 的建筑压到 20 MB，省下的
 * 是 160 MB 的上行流量和用户在进度条前等的那几分钟。放到后端压，这两样一样都省不掉。
 *
 * 这一层只管策略，不碰 three（三维那半在 `propRepack.ts`）：压不压、压完算不算数、
 * 失败怎么办，都是能拿一个假 repack 断言的普通判断。
 */

const BYTES_PER_MB = 1024 * 1024;

/**
 * 小于这个体积就不压。
 *
 * 重新打包不是无损的：导出器只认它支持的那些扩展，模型上别的东西（各类 KHR 材质扩展、
 * 作者写在 extras 里的元数据）会在往返中丢掉。8 MB 以下的模型——素材库里的道具、
 * 简单几何体——本来也没多少可省，拿这份损失去换几百 KB 不划算。
 */
export const PREVIZ_PROP_COMPRESS_MIN_BYTES = 8 * BYTES_PER_MB;

/**
 * 贴图最长边的上限，像素。
 *
 * 预演台是用来排位置和机位的，不出成片：2K 在视口里已经看不出和 4K 的区别，而像素数
 * 只有四分之一。真正的体积几乎全在贴图上——一份几十兆的模型，几何体通常只占一两兆。
 */
export const PREVIZ_PROP_MAX_TEXTURE_PX = 2048;

/** 把一份 glTF 重新打包成 .glb 的字节。默认实现在 `propRepack.ts`。 */
export type PrevizPropRepack = (file: File, maxTexturePx: number) => Promise<ArrayBuffer>;

export interface PrevizPropCompressed {
  /** 该拿去上传的文件。没压动时就是传进来的那一个（同一个引用）。 */
  file: File;
  /** 上传文件的格式。重新打包出来的一律是 glb，哪怕进来的是 .gltf。 */
  format: PrevizProp['assetFormat'];
  /** 压之前的字节数。等于 `file.size` 就表示这一趟没压动。 */
  originalBytes: number;
}

export interface PrevizPropCompressOptions {
  /**
   * 真的要压了才调一次。
   *
   * 和 `onUploadStart` 同一条理由：小文件根本不进压缩，给它弹一个「正在压缩」再立刻
   * 换成下一条，用户看到的是一次闪烁。「什么算要压」只有 `willCompressPrevizProp`
   * 一处答案。
   */
  onCompressStart?: () => void;
  /** 测试用的缝。默认实现要 three 和 canvas，两样在 jsdom 里都没有。 */
  repack?: PrevizPropRepack;
}

/** 这份文件会不会真的走一趟压缩。 */
export function willCompressPrevizProp(
  file: File,
  format: PrevizProp['assetFormat'],
): boolean {
  // obj 是纯文本几何体，贴图在另外的 .mtl 和图片文件里，而上传是单文件的——手上这份
  // obj 既没有贴图可缩，重新打包还会把它本就没有的材质坐实成没有。
  if (format === 'obj') return false;
  return file.size >= PREVIZ_PROP_COMPRESS_MIN_BYTES;
}

/**
 * 压不动、压出错、压完反而更大，一律原件照旧上传——压缩是尽力而为的优化，不该变成
 * 一道新的失败关。
 */
export async function compressPrevizProp(
  file: File,
  format: PrevizProp['assetFormat'],
  options?: PrevizPropCompressOptions,
): Promise<PrevizPropCompressed> {
  const asIs: PrevizPropCompressed = { file, format, originalBytes: file.size };
  if (!willCompressPrevizProp(file, format)) return asIs;

  options?.onCompressStart?.();
  try {
    const packed = await (options?.repack ?? repackGlb)(file, PREVIZ_PROP_MAX_TEXTURE_PX);
    // 压完更大就丢掉。输入本来就是 Draco / meshopt 压过的 glb 时必然更大：解回来的是
    // 未压缩的顶点数据。这条兜底比「先判断输入压没压过」可靠得多——那要认全每一种
    // 压缩扩展，认漏一个就白白把模型撑大。
    if (packed.byteLength >= file.size) return asIs;
    return {
      file: new File([packed], `${baseName(file.name)}.glb`, { type: 'model/gltf-binary' }),
      format: 'glb',
      originalBytes: file.size,
    };
  } catch (error) {
    console.warn('[previz] failed to repack the prop model, uploading it as is', error);
    return asIs;
  }
}

function baseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}
