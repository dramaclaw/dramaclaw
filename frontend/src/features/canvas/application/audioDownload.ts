// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  canProduceFormat,
  getAudioExtFromUrl,
  transcodeAudio,
  type AudioDownloadFormat,
} from '@/lib/audioTranscode';
import { downloadBlobAsFile, downloadUrlAsFile } from '@/lib/browserDownload';

import { resolveImageDisplayUrl } from './imageData';

/**
 * 音频「下载为指定格式」共享核心（从 NodeActionToolbar.handleAudioDownload 抽出，
 * 语义零变化）：目标容器与源一致（或 m4a 直取）时透传下载原字节；否则 fetch →
 * 前端转码 → 触发下载。转码起止通过 onConvertingChange 通知调用方（节点工具栏写
 * node data 的 convertingAudioFormat，故事板音频 chip 用本地 state）。
 * 可用性预检（canProduceFormat）与错误提示由调用方自持；失败向上抛。
 */
export async function downloadAudioAs(
  format: AudioDownloadFormat,
  params: {
    audioUrl: string;
    /** 不带扩展名的文件名主体（调用方已剥掉尾部音频扩展名）。 */
    baseFileName: string;
    onConvertingChange?: (format: AudioDownloadFormat | null) => void;
  },
): Promise<void> {
  const sourceExt = getAudioExtFromUrl(params.audioUrl);
  const filename = `${params.baseFileName}.${format}`;
  const resolvedUrl = resolveImageDisplayUrl(params.audioUrl);
  // Passthrough (target container == source): download original bytes via
  // downloadUrlAsFile (robust cross-origin fallback + correct extension),
  // no lossy re-encode.
  const passthrough =
    format === sourceExt || (format === 'm4a' && canProduceFormat('m4a', sourceExt));
  if (passthrough) {
    await downloadUrlAsFile(resolvedUrl, filename);
    return;
  }
  params.onConvertingChange?.(format);
  try {
    const resp = await fetch(resolvedUrl);
    if (!resp.ok) {
      throw new Error(`fetch failed: ${resp.status}`);
    }
    const srcBlob = await resp.blob();
    const outBlob = await transcodeAudio(srcBlob, sourceExt, format);
    downloadBlobAsFile(outBlob, filename);
  } finally {
    params.onConvertingChange?.(null);
  }
}
