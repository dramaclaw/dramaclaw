// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { createDefaultScene } from '@/features/previz/domain/scene';
import { readUrl } from '@/lib/url-params';
import { usePrevizStore } from '@/features/previz/store';
import { useAudioImport } from '@/features/previz/ui/useAudioImport';

const uploadFreezoneAudio = vi.fn(async () => ({ url: '/static/take.mp3' }));
const probeAudioDuration = vi.fn(async () => 2000);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'message' in options ? `${key}:${options.message}` : key,
  }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/url-params', () => ({ readUrl: vi.fn(() => ({ project: 'demo' })) }));
vi.mock('@/api/ops', () => ({
  uploadFreezoneAudio: (...args: unknown[]) => uploadFreezoneAudio(...(args as [])),
}));
vi.mock('@/features/previz/engine/audioProbe', () => ({
  probeAudioDuration: (...args: unknown[]) => probeAudioDuration(...(args as [])),
}));

function file(name: string, bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type: 'audio/mpeg' });
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrevizStore.getState().loadScene(createDefaultScene());
});

describe('useAudioImport local file', () => {
  it('rejects unsupported extensions and oversized files before uploading', async () => {
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('a.flac')));
    expect(toast.error).toHaveBeenCalledWith('previz.audio.badExtension');
    await act(() => result.current.addFile(file('a.mp3', 21 * 1024 * 1024)));
    expect(toast.error).toHaveBeenCalledWith('previz.audio.tooLarge');
    expect(uploadFreezoneAudio).not.toHaveBeenCalled();
  });

  it('shows a placeholder, then places the clip where the playhead was', async () => {
    usePrevizStore.getState().setTimelineFrame(20);
    let release: (() => void) | undefined;
    uploadFreezoneAudio.mockImplementationOnce(
      () =>
        new Promise<{ url: string }>((resolve) => {
          release = () => resolve({ url: '/static/take.mp3' });
        }),
    );
    const { result } = renderHook(() => useAudioImport('previz-1'));
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.addFile(file('take.mp3'));
    });
    await waitFor(() =>
      expect(result.current.pending).toEqual({
        startFrame: 20,
        endFrame: 50,
        name: 'take.mp3',
      }),
    );
    expect(uploadFreezoneAudio).toHaveBeenCalledWith(
      'demo',
      expect.any(File),
      'previz-audio-previz-1-1.mp3',
    );

    // 上传期间播放头挪走了，片段仍落在点「添加」时的位置。
    act(() => usePrevizStore.getState().setTimelineFrame(90));
    release?.();
    await act(async () => {
      await done;
    });

    expect(result.current.pending).toBeNull();
    expect(usePrevizStore.getState().scene.timeline.audio).toMatchObject([
      {
        startFrame: 20,
        endFrame: 80,
        audioUrl: '/static/take.mp3',
        sourceName: 'take.mp3',
        durationMs: 2000,
        sourceNodeId: null,
      },
    ]);
  });

  it('drops the placeholder and toasts the backend message when the upload fails', async () => {
    uploadFreezoneAudio.mockRejectedValueOnce(new Error('413 too large'));
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(result.current.pending).toBeNull();
    expect(usePrevizStore.getState().scene.timeline.audio).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith('previz.audio.uploadFailed:413 too large');
  });

  it('treats a probe failure like an upload failure', async () => {
    probeAudioDuration.mockRejectedValueOnce(new Error('audio metadata failed'));
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(usePrevizStore.getState().scene.timeline.audio).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith('previz.audio.uploadFailed:audio metadata failed');
  });

  it('toasts when the track is already full', async () => {
    // 40ms 刚好够一帧，20 段隔一帧摆开，凑满上限而不占满 120 帧的时间轴。
    for (let i = 0; i < 20; i += 1) {
      usePrevizStore
        .getState()
        .addAudioClip(
          { audioUrl: '/static/x.mp3', sourceName: 'x', durationMs: 40, sourceNodeId: null },
          i * 2,
        );
    }
    usePrevizStore.getState().setTimelineFrame(100);
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(toast.error).toHaveBeenCalledWith('previz.audio.limit');
  });

  it('does not upload when the page has no project context', async () => {
    vi.mocked(readUrl).mockReturnValueOnce({ project: null, canvas: null });
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(uploadFreezoneAudio).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('previz.editor.noProject');
  });

  it('toasts when the store has no room', async () => {
    usePrevizStore
      .getState()
      .addAudioClip(
        { audioUrl: '/static/x.mp3', sourceName: 'x', durationMs: 4000, sourceNodeId: null },
        0,
      );
    usePrevizStore.getState().setTimelineFrame(30);
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(toast.error).toHaveBeenCalledWith('previz.audio.noRoom');
  });
});

describe('useAudioImport upstream node', () => {
  it('places the clip without probing when the node knows its duration', async () => {
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() =>
      result.current.addUpstream({
        nodeId: 'audio-1',
        displayName: '旁白',
        audioUrl: '/static/vo.mp3',
        durationMs: 3000,
      }),
    );
    expect(probeAudioDuration).not.toHaveBeenCalled();
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      sourceName: '旁白',
      audioUrl: '/static/vo.mp3',
      durationMs: 3000,
      sourceNodeId: 'audio-1',
      endFrame: 90,
    });
  });

  it('probes the url when the node has no duration', async () => {
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() =>
      result.current.addUpstream({
        nodeId: 'audio-1',
        displayName: '旁白',
        audioUrl: '/static/vo.mp3',
        durationMs: null,
      }),
    );
    expect(probeAudioDuration).toHaveBeenCalledWith('/static/vo.mp3');
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      durationMs: 2000,
      endFrame: 60,
    });
  });
});
