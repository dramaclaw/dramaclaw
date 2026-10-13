// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 智能续写提交前把选区真截出来：拉源视频 → 浏览器里按时间段重编 → 传 OSS，拿到的
// 地址顶替整条源视频成为参考素材。与画面裁切共用 mediabunny 那条编码链，所以画幅
// 原样保留（后端 compose 会把竖屏素材垫成 16:9 黑边，不能拿来当续写的前情）。
import { uploadFreezoneVideo } from "@/api/ops";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { cropVideoBlob, VideoCropError } from "@/features/canvas/application/videoCrop/cropVideo";
import type { ExtendClipRange } from "@/features/canvas/application/videoExtendClip";

export interface ExtendTrimResult {
  url: string;
  durationMs: number;
}

// 同一段只截一次：生成失败后重试、一次出多条，都复用这份成品。只放内存不落节点
// 数据——落盘的话它就成了又一个要跟着画布复制/迁移的媒体字段，而重截一段几秒的
// 视频很便宜。失败的不留缓存，下次提交重新来。
const cache = new Map<string, Promise<ExtendTrimResult>>();

export function trimAndUploadExtendClip(options: {
  projectId: string;
  videoUrl: string;
  range: ExtendClipRange;
}): Promise<ExtendTrimResult> {
  const { projectId, videoUrl, range } = options;
  const key = [projectId, videoUrl, range.startMs, range.endMs].join("|");
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = run(projectId, videoUrl, range).catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

async function run(projectId: string, videoUrl: string, range: ExtendClipRange): Promise<ExtendTrimResult> {
  const response = await fetch(resolveImageDisplayUrl(videoUrl));
  if (!response.ok) throw new VideoCropError("fetchFailed", String(response.status));
  const trimmed = await cropVideoBlob({ blob: await response.blob(), trim: range });
  const { url } = await uploadFreezoneVideo(projectId, trimmed.blob, `video-extend-${Date.now()}.mp4`);
  return { url, durationMs: trimmed.durationMs };
}

/** 仅供单测清理。 */
export function resetExtendTrimCacheForTest(): void {
  cache.clear();
}
