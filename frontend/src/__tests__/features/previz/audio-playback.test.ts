// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import {
  createAudioPlayback,
  type AudioBufferSourceLike,
  type AudioContextLike,
} from '@/features/previz/engine/audioPlayback';
import type { PrevizAudioClip } from '@/features/previz/domain/scene';

function clip(id: string, startFrame: number, endFrame: number, offsetMs = 0): PrevizAudioClip {
  return {
    id,
    kind: 'audio',
    startFrame,
    endFrame,
    audioUrl: `/static/${id}.mp3`,
    sourceName: `${id}.mp3`,
    durationMs: 10_000,
    offsetMs,
    sourceNodeId: null,
  };
}

type FakeSource = AudioBufferSourceLike & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
};

function fakeContext(currentTime = 100) {
  const sources: FakeSource[] = [];
  const destination = { id: 'speakers' } as unknown as AudioNode;
  const context: AudioContextLike = {
    currentTime,
    destination,
    createBufferSource: () => {
      const source = {
        buffer: null,
        playbackRate: { value: 1 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
      sources.push(source);
      return source;
    },
    createMediaStreamDestination: () =>
      ({ stream: {} }) as unknown as MediaStreamAudioDestinationNode,
    close: vi.fn(async () => {}),
  };
  return { context, sources, destination };
}

function setup(failing: string[] = []) {
  const { context, sources, destination } = fakeContext();
  const fetchBuffer = vi.fn(async (url: string) => {
    if (failing.includes(url)) throw new Error(`boom ${url}`);
    return { url } as unknown as AudioBuffer;
  });
  const playback = createAudioPlayback({ context, fetchBuffer });
  return { playback, sources, destination, fetchBuffer };
}

describe('createAudioPlayback', () => {
  it('loads each url once and remembers failures', async () => {
    const { playback, fetchBuffer } = setup(['/static/bad.mp3']);
    await playback.load([clip('a', 0, 30), clip('a', 40, 60), clip('bad', 0, 10)]);
    await playback.load([clip('a', 0, 30)]);
    expect(fetchBuffer).toHaveBeenCalledTimes(2);
    expect([...playback.failedUrls]).toEqual(['/static/bad.mp3']);
  });

  it('starts a clip under the playhead at the matching material offset', async () => {
    const { playback, sources, destination } = setup();
    await playback.play([clip('a', 30, 90, 500)], 45, 1);
    expect(sources).toHaveLength(1);
    const [source] = sources;
    // 偏移 0.5 s，再加播放头进入片段 15 帧 = 0.5 s；剩余 45 帧 = 1.5 s。
    expect(source!.start).toHaveBeenCalledWith(100, 1, 1.5);
    expect(source!.connect).toHaveBeenCalledWith(destination);
    expect(source!.playbackRate.value).toBe(1);
  });

  it('schedules a future clip relative to the playhead, scaled by rate', async () => {
    const { playback, sources } = setup();
    await playback.play([clip('a', 60, 90)], 30, 2);
    // 30 帧 = 1 s，倍速 2 → 0.5 s 后开始；整段 30 帧 = 1 s 素材。
    expect(sources[0]!.start).toHaveBeenCalledWith(100.5, 0, 1);
    expect(sources[0]!.playbackRate.value).toBe(2);
  });

  it('skips clips that already ended and clips whose buffer failed', async () => {
    const { playback, sources } = setup(['/static/bad.mp3']);
    await playback.play([clip('a', 0, 10), clip('bad', 20, 40)], 15, 1);
    expect(sources).toHaveLength(0);
  });

  it('skips a clip under the playhead whose buffer is missing, without throwing', async () => {
    const { playback, sources } = setup(['/static/bad.mp3']);
    await expect(playback.play([clip('bad', 0, 30)], 10, 1)).resolves.toBeUndefined();
    expect(sources).toHaveLength(0);
  });

  it('routes to the given destination when recording', async () => {
    const { playback, sources } = setup();
    const mix = { id: 'mix' } as unknown as AudioNode;
    await playback.play([clip('a', 0, 30)], 0, 1, mix);
    expect(sources[0]!.connect).toHaveBeenCalledWith(mix);
  });

  it('stops and disconnects every live source', async () => {
    const { playback, sources } = setup();
    await playback.play([clip('a', 0, 30), clip('b', 40, 60)], 0, 1);
    playback.stop();
    for (const source of sources) {
      expect(source.stop).toHaveBeenCalled();
      expect(source.disconnect).toHaveBeenCalled();
    }
  });

  it('drops a play that was superseded while its buffers were loading', async () => {
    const { context, sources } = fakeContext();
    let release: (() => void) | undefined;
    const fetchBuffer = vi.fn(
      (url: string) =>
        new Promise<AudioBuffer>((resolve) => {
          release = () => resolve({ url } as unknown as AudioBuffer);
        }),
    );
    const playback = createAudioPlayback({ context, fetchBuffer });
    const first = playback.play([clip('a', 0, 30)], 0, 1);
    playback.stop();
    release?.();
    await first;
    expect(sources).toHaveLength(0);
  });

  it('closes the context on dispose', async () => {
    const { playback } = setup();
    playback.dispose();
    expect(playback.context.close).toHaveBeenCalled();
  });

  it('falls back to rate 1 when the rate is non-finite or not positive', async () => {
    const { playback, sources } = setup();
    await playback.play([clip('a', 60, 90)], 30, Number.NaN);
    expect(sources[0]!.playbackRate.value).toBe(1);
    // 30 帧 = 1 s，回退到 1 倍速 → 1 s 后开始。
    expect(sources[0]!.start).toHaveBeenCalledWith(101, 0, 1);
  });

  it('falls back to rate 1 for a zero, negative or infinite rate', async () => {
    for (const rate of [0, -2, Infinity]) {
      const { playback, sources } = setup();
      await playback.play([clip('a', 0, 30)], 0, rate);
      expect(sources[0]!.playbackRate.value).toBe(1);
    }
  });

  it('schedules nothing for a non-finite playhead', async () => {
    const { playback, sources } = setup();
    await playback.play([clip('a', 0, 30)], Number.NaN, 1);
    expect(sources).toHaveLength(0);
  });
});
