// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneVideo } from '@/api/ops';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { isVideoFile } from './videoFileTypes';
import { ensureWebSafeVideo } from './videoTranscode';

export interface VideoReplaceUploadResult {
  /** 上传后的产物地址；未成功时为 null。 */
  url: string | null;
  /** 失败原因；成功或「不是视频文件 / 缺 project」时为 null（后者只记 error 日志）。 */
  error: string | null;
}

/**
 * 替换（重传）节点视频的编排（从 VideoNode.processFile 原样搬出，语义零变化）：
 * 校验是视频 → 置 isUploading 并写 sourceFileName → HEVC 等 Web 不兼容编码先在
 * 浏览器内转成 H.264（见 videoTranscode.ts）→ 上传 → 回写 videoUrl 并清掉预览图；
 * 失败清掉 isUploading。
 *
 * 本地 objectURL 预览完全留给调用方（工作流节点用它做「上传中先看到本地画面」，
 * 故事板详情同理）：`onTranscodedPreview` 只在真的发生转码时回调一次——源编码在
 * 本浏览器可能根本解不了（Edge + HEVC），此时本地预览也得换成转码产物。
 */
export async function replaceNodeVideo(
  nodeId: string,
  file: File,
  hooks?: { onTranscodedPreview?: (transcoded: File) => void },
): Promise<VideoReplaceUploadResult> {
  if (!isVideoFile(file)) return { url: null, error: null };
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[video-replace] no project in URL');
    return { url: null, error: null };
  }
  const store = useCanvasStore.getState();
  store.updateNodeData(nodeId, { sourceFileName: file.name, isUploading: true });
  try {
    // HEVC（飞书录屏/iPhone）等 Web 不兼容编码先在浏览器内转成 H.264 再上传，
    // 否则 Edge 等无对应解码器的浏览器只有声音没画面。见 videoTranscode.ts。
    // 转码期间 UI 统一走「上传中」loading，不单独显示转码进度。
    const prepared = await ensureWebSafeVideo(file);
    if (prepared.transcoded) {
      hooks?.onTranscodedPreview?.(prepared.file);
    }
    const uploaded = await uploadFreezoneVideo(
      projectId,
      prepared.file,
      prepared.file.name,
    );
    useCanvasStore.getState().updateNodeData(nodeId, {
      videoUrl: uploaded.url,
      previewImageUrl: null,
      sourceFileName: file.name,
      isUploading: false,
    });
    return { url: uploaded.url, error: null };
  } catch (error) {
    console.error('[video-replace] upload failed', error);
    useCanvasStore.getState().updateNodeData(nodeId, { isUploading: false });
    return {
      url: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
