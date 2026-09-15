// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 画面裁切的编码：mediabunny Conversion 自带 crop（旋转之后、缩放之前，显示像素空间），
// 视频重编成 H.264，音轨能直通就直通。跑在主线程——编解码本身是 WebCodecs 异步做的。
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from "mediabunny";

import { toEvenSourceRect, type CropBox } from "@/features/canvas/application/videoCrop/cropMath";

/** 与 videoTranscode 的 MAX_TRANSCODE_BYTES 同一口径：BufferTarget 整个成品在内存里。 */
export const CROP_MAX_SOURCE_BYTES = 800 * 1024 * 1024;

export type VideoCropErrorCode =
  | "tooLarge"
  | "noVideoTrack"
  | "cannotDecode"
  | "fetchFailed"
  | "canceled"
  | "failed";

export class VideoCropError extends Error {
  readonly code: VideoCropErrorCode;

  constructor(code: VideoCropErrorCode, message: string) {
    super(message);
    this.name = "VideoCropError";
    this.code = code;
  }
}

export interface CropVideoOptions {
  blob: Blob;
  /** UI 里的框，坐标系是 sourceWidth × sourceHeight。 */
  box: CropBox;
  sourceWidth: number;
  sourceHeight: number;
  onProgress?: (progress: number) => void;
  /** 中途取消：已经中止就直接短路，跑起来了就转发给 conversion.cancel()。 */
  signal?: AbortSignal;
}

export interface CropVideoResult {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number;
}

// no_encodable_target_codec 是浏览器没有 H.264 编码器，不是解不了源，不能归到 cannotDecode。
const UNDECODABLE_VIDEO_REASONS = new Set(["unknown_source_codec", "undecodable_source_codec"]);

export async function cropVideoBlob({
  blob,
  box,
  sourceWidth,
  sourceHeight,
  onProgress,
  signal,
}: CropVideoOptions): Promise<CropVideoResult> {
  if (blob.size > CROP_MAX_SOURCE_BYTES) {
    throw new VideoCropError("tooLarge", `${Math.round(blob.size / 1024 / 1024)} MB`);
  }
  if (signal?.aborted) {
    // 还没开始就已经被取消，连 Input 都不用开。
    throw new VideoCropError("canceled", "aborted before starting");
  }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new VideoCropError("noVideoTrack", "no video track");
    if (!(await track.canDecode())) {
      throw new VideoCropError("cannotDecode", String(await track.getCodec()));
    }

    // 节点上的 widthPx/heightPx 可能过期（比如换过视频），以轨道显示尺寸为准，
    // 框按比例换算过去再取偶数，不然会裁偏。
    const displayWidth = await track.getDisplayWidth();
    const displayHeight = await track.getDisplayHeight();
    const scaleX = sourceWidth > 0 ? displayWidth / sourceWidth : 1;
    const scaleY = sourceHeight > 0 ? displayHeight / sourceHeight : 1;
    const rect = toEvenSourceRect(
      { x: box.x * scaleX, y: box.y * scaleY, width: box.width * scaleX, height: box.height * scaleY },
      displayWidth,
      displayHeight,
    );

    const audioTrack = await input.getPrimaryAudioTrack();
    const audioCodec = audioTrack ? await audioTrack.getCodec() : null;
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      video: { codec: "avc", bitrate: QUALITY_HIGH, crop: rect },
      // AAC/MP3 直通不重编；其余（pcm、ac3、opus…）重编成 AAC，与 videoTranscode 一致。
      audio:
        audioCodec && !["aac", "mp3"].includes(audioCodec)
          ? { codec: "aac", bitrate: 128_000 }
          : undefined,
      showWarnings: false,
    });

    const reasons = conversion.discardedTracks
      .map((entry) => `${entry.track.type}:${entry.reason}`)
      .join(", ");
    // 视频轨被丢了 isValid 仍可能是 true（音轨还在），那样会产出一个纯音频文件。
    const droppedVideo = conversion.discardedTracks.find((entry) => entry.track.type === "video");
    if (droppedVideo) {
      throw new VideoCropError(
        UNDECODABLE_VIDEO_REASONS.has(droppedVideo.reason) ? "cannotDecode" : "failed",
        reasons,
      );
    }
    if (!conversion.isValid) throw new VideoCropError("failed", `conversion invalid (${reasons})`);

    conversion.onProgress = (progress) => onProgress?.(progress);

    if (signal?.aborted) {
      // init() 本身没有取消口子，跑完了才能问；这里补上「取消发生在 init
      // 期间」这个窗口，避免白跑一次 execute()。
      throw new VideoCropError("canceled", "aborted before execute");
    }
    // conversion.cancel() 返回的是 Promise<void>；不接住的话，cancel 本身若拒绝
    // （比如这时 execute() 已经跑完），会变成一个没人处理的 unhandled rejection。
    const onAbort = () => void conversion.cancel().catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await conversion.execute();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer || buffer.byteLength === 0) {
      throw new VideoCropError("failed", "conversion produced empty output");
    }
    const durationSec = await input.computeDuration();
    return {
      blob: new Blob([buffer], { type: "video/mp4" }),
      width: rect.width,
      height: rect.height,
      durationMs: Math.round(durationSec * 1000),
    };
  } catch (error) {
    if (error instanceof VideoCropError) throw error;
    if (error instanceof ConversionCanceledError || signal?.aborted) {
      throw new VideoCropError("canceled", error instanceof Error ? error.message : String(error));
    }
    throw new VideoCropError("failed", error instanceof Error ? error.message : String(error));
  } finally {
    input.dispose();
  }
}
