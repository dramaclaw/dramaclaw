// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import { PREVIZ_MIN_CLIP_FRAMES, type PrevizAudioClip, type PrevizScene } from './scene';

/** 音频片段上限。一条轨道 20 段已经是配音级别的密度，再多就该去剪辑软件里做。 */
export const PREVIZ_MAX_AUDIO_CLIPS = 20;
/** 单个音频文件上限：20 MB，约一小时的 48 kbps mp3，或两分钟的 44.1 kHz 立体声 wav。 */
export const PREVIZ_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** mp3/wav 三大内核都能解；m4a/ogg 依赖系统解码器，解不出来时由播放层的解码失败分支兜底。 */
export const PREVIZ_AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'ogg'] as const;

/** 建片段需要的素材信息。`durationMs` 由调用方探测好再传进来，域层不碰 DOM。 */
export interface PrevizAudioSource {
  audioUrl: string;
  sourceName: string;
  durationMs: number;
  sourceNodeId: string | null;
}

/** 素材从 `offsetMs` 起还剩多少整帧。向下取整：多出的半帧没有声音可放。 */
export function audioFramesAvailable(durationMs: number, offsetMs: number, fps: number): number {
  // offsetMs 多半是帧换算来的循环小数，乘回去会差在小数点后十几位，别让它吞掉一帧。
  return Math.max(0, Math.floor(((durationMs - offsetMs) * fps) / 1000 + 1e-6));
}

export function framesToMs(frames: number, fps: number): number {
  return (frames * 1000) / fps;
}

export type AudioInsertRejection = 'no-room' | 'limit';

export type InsertAudioClipResult =
  | { ok: true; scene: PrevizScene; clipId: string }
  | { ok: false; reason: AudioInsertRejection };

/**
 * 在播放头处放一段音频：起点 = 播放头，长度 = min(素材帧数, 到下一段或时间轴末尾的空隙)。
 * 播放头压在既有片段里、空隙不足一帧、或已到上限时不建——同 `insertCut`，拒绝时不给场景。
 * 上限先查：到了 20 段换个位置也没用，提示「已到上限」比「没空间」更能指路。
 */
export function insertAudioClip(
  scene: PrevizScene,
  frame: number,
  source: PrevizAudioSource,
): InsertAudioClipResult {
  const audio = scene.timeline.audio;
  if (audio.length >= PREVIZ_MAX_AUDIO_CLIPS) return { ok: false, reason: 'limit' };
  // 帧号不是有限数就没有「这一帧」可放，按没空间处理，别让 NaN 混进快照。
  if (!Number.isFinite(frame)) return { ok: false, reason: 'no-room' };
  // 素材时长不是有限正数就没有帧可放——`HTMLMediaElement.duration` 在元数据到位前就是 NaN。
  if (!Number.isFinite(source.durationMs) || source.durationMs <= 0) {
    return { ok: false, reason: 'no-room' };
  }

  const at = Math.max(0, Math.round(frame));
  if (audio.some((clip) => clip.startFrame <= at && at < clip.endFrame)) {
    return { ok: false, reason: 'no-room' };
  }
  const nextIndex = audio.findIndex((clip) => clip.startFrame > at);
  const gapEnd = nextIndex >= 0 ? audio[nextIndex]!.startFrame : scene.settings.durationFrames;
  const length = Math.min(
    gapEnd - at,
    audioFramesAvailable(source.durationMs, 0, scene.settings.fps),
  );
  if (length < PREVIZ_MIN_CLIP_FRAMES) return { ok: false, reason: 'no-room' };

  const clip: PrevizAudioClip = {
    id: uuidv4(),
    kind: 'audio',
    startFrame: at,
    endFrame: at + length,
    audioUrl: source.audioUrl,
    sourceName: source.sourceName,
    durationMs: source.durationMs,
    offsetMs: 0,
    sourceNodeId: source.sourceNodeId,
  };
  const next =
    nextIndex >= 0
      ? [...audio.slice(0, nextIndex), clip, ...audio.slice(nextIndex)]
      : [...audio, clip];
  return {
    ok: true,
    scene: { ...scene, timeline: { ...scene.timeline, audio: next } },
    clipId: clip.id,
  };
}

/** 小写、不带点的扩展名；没有点就是空串。 */
export function audioFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** 前端能做的两项校验。后端还会再查一次类型，这里只是省一次白传。 */
export function isAcceptedAudioFile(name: string, bytes: number): 'ok' | 'extension' | 'size' {
  const extension = audioFileExtension(name);
  if (!(PREVIZ_AUDIO_EXTENSIONS as readonly string[]).includes(extension)) return 'extension';
  if (bytes > PREVIZ_MAX_AUDIO_BYTES) return 'size';
  return 'ok';
}
