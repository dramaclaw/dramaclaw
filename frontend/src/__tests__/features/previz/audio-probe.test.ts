// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeAudioDuration } from '@/features/previz/engine/audioProbe';

/**
 * jsdom 能建出真的 `<audio>` 元素，但读不出真实时长——那要真去解码一个文件。
 * 劫持 document.createElement('audio') 拿到这个真实例的引用，手动摆好
 * duration 再触发 onloadedmetadata/onerror，绕开真实解码这一步。
 */
function stubAudioElement(): HTMLAudioElement {
  const createElement = document.createElement.bind(document);
  const audio = createElement('audio') as HTMLAudioElement;
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) =>
    tagName === 'audio' ? audio : createElement(tagName)) as typeof document.createElement);
  return audio;
}

function setDuration(audio: HTMLAudioElement, seconds: number) {
  Object.defineProperty(audio, 'duration', { value: seconds, configurable: true });
}

describe('probeAudioDuration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the rounded duration in milliseconds', async () => {
    const audio = stubAudioElement();
    const promise = probeAudioDuration('/static/a.mp3');
    setDuration(audio, 1.2345);
    audio.onloadedmetadata?.(new Event('loadedmetadata'));
    await expect(promise).resolves.toBe(1235);
  });

  it('rejects when the duration is infinite', async () => {
    const audio = stubAudioElement();
    const promise = probeAudioDuration('/static/a.mp3');
    setDuration(audio, Infinity);
    audio.onloadedmetadata?.(new Event('loadedmetadata'));
    await expect(promise).rejects.toThrow('audio duration unavailable');
  });

  it('rejects when the duration is zero', async () => {
    const audio = stubAudioElement();
    const promise = probeAudioDuration('/static/a.mp3');
    setDuration(audio, 0);
    audio.onloadedmetadata?.(new Event('loadedmetadata'));
    await expect(promise).rejects.toThrow('audio duration unavailable');
  });

  it('rejects when the audio element errors', async () => {
    const audio = stubAudioElement();
    const promise = probeAudioDuration('/static/a.mp3');
    audio.onerror?.(new Event('error'));
    await expect(promise).rejects.toThrow('audio metadata failed');
  });

  it('revokes the object URL for a File source on the success path', async () => {
    const audio = stubAudioElement();
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = new File(['x'], 'clip.mp3', { type: 'audio/mpeg' });
    const promise = probeAudioDuration(file);
    setDuration(audio, 2);
    audio.onloadedmetadata?.(new Event('loadedmetadata'));
    await promise;
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('revokes the object URL for a File source on the error path', async () => {
    const audio = stubAudioElement();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = new File(['x'], 'clip.mp3', { type: 'audio/mpeg' });
    const promise = probeAudioDuration(file);
    audio.onerror?.(new Event('error'));
    await expect(promise).rejects.toThrow('audio metadata failed');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('never touches the object URL API for a string source', async () => {
    const audio = stubAudioElement();
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');
    const promise = probeAudioDuration('/static/a.mp3');
    setDuration(audio, 2);
    audio.onloadedmetadata?.(new Event('loadedmetadata'));
    await promise;
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
