// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureVideoFrames,
  clearVideoFrameCache,
} from '@/features/canvas/application/videoFrameStrip';

/** 假 <video>：jsdom 不解码，seeked/loadeddata 全由用例手动喂。 */
class FakeVideo {
  listeners = new Map<string, Set<() => void>>();
  duration = 8;
  videoWidth = 1920;
  videoHeight = 1080;
  currentTime = 0;
  muted = false;
  playsInline = false;
  preload = '';
  crossOrigin: string | null = null;
  src = '';
  loadCount = 0;

  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }

  removeAttribute() {}

  load() {
    this.loadCount += 1;
  }

  emit(type: string) {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

let videos: FakeVideo[] = [];

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => `frame-${videos[videos.length - 1]?.currentTime ?? 0}`,
  };
  return canvas as unknown as HTMLCanvasElement;
}

/** 走完一整条带子：loadeddata + count 次 seeked。 */
function feed(video: FakeVideo, count: number) {
  video.emit('loadeddata');
  for (let i = 0; i < count; i += 1) video.emit('seeked');
}

beforeEach(() => {
  videos = [];
  clearVideoFrameCache();
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') {
      const video = new FakeVideo();
      videos.push(video);
      return video as unknown as HTMLVideoElement;
    }
    if (tag === 'canvas') return fakeCanvas();
    throw new Error(`unexpected createElement(${tag})`);
  }) as typeof document.createElement);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearVideoFrameCache();
});

describe('captureVideoFrames', () => {
  it('抽满后按 (src, count) 复用结果，不再开第二个 <video>', async () => {
    const first = captureVideoFrames('https://cdn.example.com/a.mp4', 3);
    feed(videos[0], 3);
    expect(await first).toHaveLength(3);
    expect(videos).toHaveLength(1);

    // 面板反复挂载（LOD、切模式）时命中缓存，省掉一整轮 seek + 解码。
    expect(await captureVideoFrames('https://cdn.example.com/a.mp4', 3)).toHaveLength(3);
    expect(videos).toHaveLength(1);
  });

  it('换 src 或换帧数都要重新抽', async () => {
    const first = captureVideoFrames('https://cdn.example.com/a.mp4', 3);
    feed(videos[0], 3);
    await first;

    const other = captureVideoFrames('https://cdn.example.com/b.mp4', 3);
    feed(videos[1], 3);
    await other;

    const wider = captureVideoFrames('https://cdn.example.com/a.mp4', 4);
    feed(videos[2], 4);
    await wider;

    expect(videos).toHaveLength(3);
  });

  it('结束后把监听器和 src 都摘干净', async () => {
    const pending = captureVideoFrames('https://cdn.example.com/a.mp4', 2);
    feed(videos[0], 2);
    await pending;

    expect(videos[0].listenerCount).toBe(0);
  });

  it('一帧都没抽到就卡死时超时报错，不会一直挂着', async () => {
    vi.useFakeTimers();
    const pending = captureVideoFrames('https://cdn.example.com/stuck.mp4', 4);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    videos[0].emit('loadeddata'); // seek 出去了，seeked 永远不回来
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(videos[0].listenerCount).toBe(0);
  });

  it('抽到一半卡住就交半条带子，而且不进缓存', async () => {
    vi.useFakeTimers();
    const pending = captureVideoFrames('https://cdn.example.com/half.mp4', 4);
    videos[0].emit('loadeddata');
    videos[0].emit('seeked');
    videos[0].emit('seeked');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toHaveLength(2);

    // 降级结果不缓存：下次挂载还有机会抽全。
    vi.useRealTimers();
    const retry = captureVideoFrames('https://cdn.example.com/half.mp4', 4);
    expect(videos).toHaveLength(2);
    feed(videos[1], 4);
    expect(await retry).toHaveLength(4);
  });

  it('失败不进缓存，下次还能重试', async () => {
    const pending = captureVideoFrames('https://cdn.example.com/bad.mp4', 2);
    const assertion = expect(pending).rejects.toThrow(/video element error/);
    videos[0].emit('error');
    await assertion;

    const retry = captureVideoFrames('https://cdn.example.com/bad.mp4', 2);
    expect(videos).toHaveLength(2);
    feed(videos[1], 2);
    expect(await retry).toHaveLength(2);
  });
});
