// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
  type AudioCodec,
} from 'mediabunny';

import { PREVIZ_FPS, type PrevizAudioClip } from '../domain/scene';

/**
 * 逐帧离线出片：画一帧、编一帧，时间戳是「第几帧 / 帧率」，跟墙上时钟无关。
 *
 * `recordTimeline` 那条实时路径（MediaRecorder）在渲染跟不上时只能丢帧，重场景录出来
 * 平均只有十几帧，下游的视频模型按帧率下限直接拒收。这里渲染慢只是录得久，成片恒定
 * 帧率、一帧不少。另一个顺带的好处：采样与绘制在同一个任务里，不存在 WebGL 绘制缓冲
 * 已经被合成清掉、采到空画面的那一拍。
 *
 * 浏览器没有 WebCodecs H.264 编码时仍走 `recordTimeline`。
 */

/** 离线路径固定出 H.264 的 mp4。 */
export const OFFLINE_RECORD_MIME = 'video/mp4';

/** 同实时路径：1080p30 给 12 Mbps，再低运镜时的网格会糊成一团块。 */
const VIDEO_BITRATE = 12_000_000;
const AUDIO_BITRATE = 128_000;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;

export interface FrameEncoderLike {
  /** 把画布当下的内容编成第 `frame` 帧；队列满时等编码器消化完再返回。 */
  addFrame(frame: number): Promise<void>;
  /** 收尾并交出成片；`audio` 给了就编成音轨。 */
  finish(audio: AudioBuffer | null): Promise<Blob>;
  /** 中途出错时放掉编码器。 */
  cancel(): Promise<void>;
}

export interface EncodeTimelineDeps {
  /** 时间轴总帧数；从第 0 帧编到这一帧。 */
  durationFrames: number;
  /** 解算并画出某一帧。 */
  drawFrame: (frame: number) => void;
  encoder: FrameEncoderLike;
  /** 每帧之间让出主线程，进度条与停止按钮才有机会响应。浏览器里是 requestAnimationFrame。 */
  yieldToUi: () => Promise<void>;
  /** 画面编完后按实际编到的那一帧混出音轨；不给就是无声。 */
  mixAudio?: (lastFrame: number) => Promise<AudioBuffer | null>;
  onProgress?: (ratio: number) => void;
  /** 返回 true 就提前收工（用户点了停止）。已编的部分照常出片。 */
  shouldStop?: () => boolean;
}

export async function encodeTimeline(deps: EncodeTimelineDeps): Promise<Blob> {
  const lastFrame = Math.max(0, Math.round(deps.durationFrames));
  try {
    let encoded = 0;
    for (let frame = 0; frame <= lastFrame; frame += 1) {
      // 第 0 帧无论如何都编：一帧都没有的 mp4 不是合法成片。
      if (frame > 0 && deps.shouldStop?.()) break;
      deps.drawFrame(frame);
      // 画完立刻采，中间不能让出主线程：WebGL 的绘制缓冲一合成就清了。
      await deps.encoder.addFrame(frame);
      encoded = frame;
      deps.onProgress?.(lastFrame > 0 ? frame / lastFrame : 1);
      await deps.yieldToUi();
    }
    const audio = deps.mixAudio ? await deps.mixAudio(encoded) : null;
    return await deps.encoder.finish(audio);
  } catch (error) {
    await deps.encoder.cancel().catch(() => {});
    throw error;
  }
}

/** 这个尺寸的 H.264 浏览器编不编得了；编不了就退回实时录制。 */
export function canEncodeOffline(size: { width: number; height: number }): Promise<boolean> {
  return canEncodeVideo('avc', { ...size, bitrate: VIDEO_BITRATE }).catch(() => false);
}

/** mp4 里浏览器编得出来的第一种音频编码（优先 AAC）；一种都没有就只能出无声。 */
export function pickOfflineAudioCodec(): Promise<AudioCodec | null> {
  return getFirstEncodableAudioCodec(new Mp4OutputFormat().getSupportedAudioCodecs(), {
    numberOfChannels: AUDIO_CHANNELS,
    sampleRate: AUDIO_SAMPLE_RATE,
    bitrate: AUDIO_BITRATE,
  }).catch(() => null);
}

/**
 * 浏览器实现：WebCodecs 编 H.264，mediabunny 封 mp4。传进来的是预演台视口那块 WebGL
 * 画布本身（见 `PrevizRenderer.startRecording`）。
 */
export async function createCanvasFrameEncoder(
  canvas: HTMLCanvasElement,
  options: { fps: number; audioCodec: AudioCodec | null },
): Promise<FrameEncoderLike> {
  const target = new BufferTarget();
  const output = new Output({
    // faststart：moov 放前面，OSS 直链流式播放不用等整个文件。
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });
  const video = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: VIDEO_BITRATE,
    keyFrameInterval: 1,
  });
  output.addVideoTrack(video, { frameRate: options.fps });
  const audio = options.audioCodec
    ? new AudioBufferSource({ codec: options.audioCodec, bitrate: AUDIO_BITRATE })
    : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();

  return {
    addFrame: (frame) => video.add(frame / options.fps, 1 / options.fps),
    async finish(mixed) {
      if (audio && mixed) await audio.add(mixed);
      await output.finalize();
      return new Blob([target.buffer ?? new ArrayBuffer(0)], { type: OFFLINE_RECORD_MIME });
    },
    cancel: () => output.cancel(),
  };
}

/** `OfflineAudioContext` 里用得到的那一小块，测试给假的即可。 */
export interface OfflineAudioContextLike {
  readonly destination: AudioNode;
  createBufferSource(): {
    buffer: AudioBuffer | null;
    connect(destination: AudioNode): unknown;
    start(when?: number, offset?: number, duration?: number): void;
  };
  startRendering(): Promise<AudioBuffer>;
}

/**
 * 把音频轨离线混成一条 `seconds` 长的缓冲，从第 0 帧、1 倍速排——成片是按帧率逐帧画的
 * 实速素材。没有一段排得上（轨是空的、素材都没解出来）时返回 null，成片就不带音轨。
 */
export async function mixTimelineAudio(
  clips: readonly PrevizAudioClip[],
  bufferFor: (url: string) => AudioBuffer | undefined,
  seconds: number,
  createContext: (length: number, sampleRate: number) => OfflineAudioContextLike = (
    length,
    sampleRate,
  ) => new OfflineAudioContext(AUDIO_CHANNELS, length, sampleRate),
): Promise<AudioBuffer | null> {
  const length = Math.ceil(seconds * AUDIO_SAMPLE_RATE);
  if (!(length > 0)) return null;
  let context: OfflineAudioContextLike | null = null;
  for (const clip of clips) {
    const buffer = bufferFor(clip.audioUrl);
    if (!buffer) continue;
    // 起点压到第 0 帧：片段从负帧开始时，跳过素材里落在片头之前的那一截。
    const startFrame = Math.max(0, clip.startFrame);
    if (clip.endFrame <= startFrame || startFrame / PREVIZ_FPS >= seconds) continue;
    context ??= createContext(length, AUDIO_SAMPLE_RATE);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(
      startFrame / PREVIZ_FPS,
      clip.offsetMs / 1000 + (startFrame - clip.startFrame) / PREVIZ_FPS,
      (clip.endFrame - startFrame) / PREVIZ_FPS,
    );
  }
  return context ? await context.startRendering() : null;
}
