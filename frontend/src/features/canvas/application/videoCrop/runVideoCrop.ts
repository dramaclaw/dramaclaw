// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 画面裁切的执行链：拉源视频 → 浏览器里裁 → 传 OSS。建节点、连边留给 VideoNode，
// 这里不碰画布 store，方便单测。
import { uploadFreezoneVideo } from "@/api/ops";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import type { CropBox } from "@/features/canvas/application/videoCrop/cropMath";
import { cropVideoBlob, VideoCropError } from "@/features/canvas/application/videoCrop/cropVideo";

export interface CropAndUploadOptions {
  projectId: string;
  videoUrl: string;
  box: CropBox;
  sourceWidth: number;
  sourceHeight: number;
  signal?: AbortSignal;
}

export interface CropAndUploadResult {
  url: string;
  width: number;
  height: number;
  durationMs: number;
}

export async function cropAndUploadVideo(options: CropAndUploadOptions): Promise<CropAndUploadResult> {
  const { signal } = options;
  let response: Response;
  let source: Blob;
  try {
    // response.blob() 跟 fetch() 放同一个 try 里：body 还没读完时中止，fetch()
    // 本身早就 resolve 了，真正抛 AbortError 的是这一步的流读取，不在这里接就会
    // 被当成普通失败，走到「裁剪失败」而不是「已取消裁剪」。
    response = await fetch(resolveImageDisplayUrl(options.videoUrl), { signal });
    if (!response.ok) throw new VideoCropError("fetchFailed", String(response.status));
    source = await response.blob();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new VideoCropError("canceled", "aborted during fetch");
    }
    throw error;
  }
  if (signal?.aborted) throw new VideoCropError("canceled", "aborted after fetch");

  const cropped = await cropVideoBlob({
    blob: source,
    box: options.box,
    sourceWidth: options.sourceWidth,
    sourceHeight: options.sourceHeight,
    signal,
  });

  if (signal?.aborted) {
    // 裁剪结果算完了但用户已经点了取消——这时还没传 OSS，直接不传，不留孤儿。
    throw new VideoCropError("canceled", "aborted before upload");
  }

  let url: string;
  try {
    ({ url } = await uploadFreezoneVideo(
      options.projectId,
      cropped.blob,
      `video-crop-${Date.now()}.mp4`,
      { signal },
    ));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new VideoCropError("canceled", "aborted during upload");
    }
    throw error;
  }
  // 上传现在能真中止了，但仍有一个窄窗口：服务端已经收完整个 body 并回了响应，
  // 用户几乎同时点了取消——ky 不一定来得及把这次成功响应变成 AbortError。留这
  // 一道兜底：文件已经躺在 OSS 上（不去删，见上面 upload 调用点），但不建节点。
  if (signal?.aborted) {
    throw new VideoCropError("canceled", "aborted during upload");
  }
  return { url, width: cropped.width, height: cropped.height, durationMs: cropped.durationMs };
}
