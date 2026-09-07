// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { PREVIZ_FPS, type PrevizAudioClip } from '../domain/scene';

/**
 * 音频轨的播放引擎。只认「一组片段 + 从哪一帧起 + 倍速」，把每段换算成
 * `AudioBufferSourceNode.start(when, offset, duration)` 一次排完；播放头一跳、
 * 倍速一改，编辑器就 stop 再 play，不做增量。
 *
 * `AudioContext` 与解码由外面注入，测试给假的即可；浏览器胶水在文件底部。
 */

export interface AudioBufferSourceLike {
  buffer: AudioBuffer | null;
  playbackRate: { value: number };
  connect(destination: AudioNode): unknown;
  start(when?: number, offset?: number, duration?: number): void;
  stop(): void;
  disconnect(): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNode;
  createBufferSource(): AudioBufferSourceLike;
  createMediaStreamDestination(): MediaStreamAudioDestinationNode;
  close(): Promise<void>;
}

export interface AudioPlaybackDeps {
  context: AudioContextLike;
  fetchBuffer: (url: string) => Promise<AudioBuffer>;
}

export interface PrevizAudioPlayback {
  readonly context: AudioContextLike;
  /** 预取并解码所有片段的素材；失败的 url 记进 `failedUrls`，不抛。 */
  load(clips: readonly PrevizAudioClip[]): Promise<void>;
  /** 从 `fromFrame` 起按 `rate` 播；`destination` 缺省为扬声器，录制时传混音节点。 */
  play(
    clips: readonly PrevizAudioClip[],
    fromFrame: number,
    rate: number,
    destination?: AudioNode,
  ): Promise<void>;
  stop(): void;
  dispose(): void;
  readonly failedUrls: ReadonlySet<string>;
}

export function createAudioPlayback(deps: AudioPlaybackDeps): PrevizAudioPlayback {
  const { context, fetchBuffer } = deps;
  const buffers = new Map<string, AudioBuffer>();
  const loading = new Map<string, Promise<void>>();
  const failedUrls = new Set<string>();
  let live: AudioBufferSourceLike[] = [];
  // 每次 play/stop +1；load 期间又来了一次 stop 或 play，旧的那次拿到 buffer 后什么都不做。
  let generation = 0;

  function loadOne(url: string): Promise<void> {
    if (buffers.has(url) || failedUrls.has(url)) return Promise.resolve();
    const pending = loading.get(url);
    if (pending) return pending;
    const task = fetchBuffer(url)
      .then((buffer) => {
        buffers.set(url, buffer);
      })
      .catch((error: unknown) => {
        failedUrls.add(url);
        console.warn('[previz] audio decode failed', url, error);
      })
      .finally(() => {
        loading.delete(url);
      });
    loading.set(url, task);
    return task;
  }

  function loadAll(clips: readonly PrevizAudioClip[]): Promise<void> {
    const urls = [...new Set(clips.map((clip) => clip.audioUrl))];
    return Promise.all(urls.map(loadOne)).then(() => {});
  }

  function stop() {
    generation += 1;
    for (const source of live) {
      try {
        source.stop();
      } catch {
        // 还没 start 过的源 stop 会抛 InvalidStateError，忽略。
      }
      source.disconnect();
    }
    live = [];
  }

  async function play(
    clips: readonly PrevizAudioClip[],
    fromFrame: number,
    rate: number,
    destination?: AudioNode,
  ): Promise<void> {
    stop();
    const mine = generation;
    await loadAll(clips);
    if (mine !== generation) return;
    // 播放头必须是有限数才谈得上「谁在播放头下面」；非法值就什么都不排。
    if (!Number.isFinite(fromFrame)) return;
    // 非正、非有限的倍速（0、负数、NaN、Infinity）会让 start() 的 when 算出
    // NaN 或 Infinity 而抛 RangeError，退回 1 倍速播完整。
    const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const now = context.currentTime;
    const target = destination ?? context.destination;
    for (const clip of clips) {
      if (clip.endFrame <= fromFrame) continue;
      const buffer = buffers.get(clip.audioUrl);
      if (!buffer) continue;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = safeRate;
      source.connect(target);
      if (clip.startFrame <= fromFrame) {
        // 播放头已在段内：从素材里对应的位置起，放到段尾。
        const offset = clip.offsetMs / 1000 + (fromFrame - clip.startFrame) / PREVIZ_FPS;
        source.start(now, offset, (clip.endFrame - fromFrame) / PREVIZ_FPS);
      } else {
        // 还没到：按倍速折算等待时间，整段素材照常。
        const when = now + (clip.startFrame - fromFrame) / PREVIZ_FPS / safeRate;
        const duration = (clip.endFrame - clip.startFrame) / PREVIZ_FPS;
        source.start(when, clip.offsetMs / 1000, duration);
      }
      live.push(source);
    }
  }

  return {
    context,
    failedUrls,
    load: loadAll,
    play,
    stop,
    dispose() {
      stop();
      void context.close();
      buffers.clear();
      loading.clear();
    },
  };
}

let warnedNoAudioContext = false;

/** 浏览器不给 AudioContext（隐私模式、无音频设备）时静音继续，只在控制台说一次。 */
export function createAudioContext(): AudioContext | null {
  try {
    return new AudioContext();
  } catch (error) {
    if (!warnedNoAudioContext) {
      warnedNoAudioContext = true;
      console.warn('[previz] AudioContext unavailable, audio track is muted', error);
    }
    return null;
  }
}

export async function fetchAudioBuffer(context: AudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`audio fetch failed: ${response.status}`);
  return context.decodeAudioData(await response.arrayBuffer());
}
