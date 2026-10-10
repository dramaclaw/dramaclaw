// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { createDefaultScene } from '@/features/previz/domain/scene';
import { readUrl } from '@/lib/url-params';
import { usePrevizStore } from '@/features/previz/store';
import { useAudioImport } from '@/features/previz/ui/useAudioImport';

/** 写出参数类型，下面那条「两次不同名」才读得到第三个参数——上传用的文件名。 */
const uploadFreezoneAudio = vi.fn<
  (project: string, file: File, name: string) => Promise<{ url: string }>
>(async () => ({ url: '/static/take.mp3' }));
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
  uploadFreezoneAudio: (...args: unknown[]) =>
    uploadFreezoneAudio(...(args as [string, File, string])),
}));
vi.mock('@/features/previz/engine/audioProbe', () => ({
  probeAudioDuration: (...args: unknown[]) => probeAudioDuration(...(args as [])),
}));

function file(name: string, bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type: 'audio/mpeg' });
}

/** 把上传或探测按在半途，好观察「还在传」这段时间里 hook 的样子。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  // clearAllMocks 只清调用记录，`mockImplementationOnce` 的队列和这里的默认实现都还在；
  // 换成 mockReset 会把上面两个 vi.fn 的默认实现一起抹掉，别顺手「修正」。
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
      // 尾巴上那串时间戳的值不钉死，它归下面那条「两次导入不同名」管。
      expect.stringMatching(/^previz-audio-previz-1-\d+\.mp3$/),
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

  it('starts the upload without waiting for the probe', async () => {
    // 并行是有意的：探时长和传文件互不依赖，串起来等于让人多等一整个 upload。
    const probe = deferred<number>();
    probeAudioDuration.mockReturnValueOnce(probe.promise);
    const { result } = renderHook(() => useAudioImport('previz-1'));
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.addFile(file('take.mp3'));
    });
    await waitFor(() => expect(uploadFreezoneAudio).toHaveBeenCalledTimes(1));
    probe.resolve(2000);
    await act(async () => {
      await done;
    });
    expect(usePrevizStore.getState().scene.timeline.audio).toHaveLength(1);
  });

  it('clamps the placeholder to the end of the timeline', async () => {
    usePrevizStore.getState().setTimelineFrame(100);
    const probe = deferred<number>();
    probeAudioDuration.mockReturnValueOnce(probe.promise);
    const { result } = renderHook(() => useAudioImport('previz-1'));
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.addFile(file('take.mp3'));
    });
    await waitFor(() =>
      expect(result.current.pending).toEqual({
        startFrame: 100,
        endFrame: 120,
        name: 'take.mp3',
      }),
    );
    probe.resolve(2000);
    await act(async () => {
      await done;
    });
  });

  it('keeps the second placeholder when the first import settles', async () => {
    const first = deferred<{ url: string }>();
    const second = deferred<{ url: string }>();
    uploadFreezoneAudio.mockReturnValueOnce(first.promise);
    uploadFreezoneAudio.mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useAudioImport('previz-1'));
    let a: Promise<void> | undefined;
    let b: Promise<void> | undefined;
    act(() => {
      a = result.current.addFile(file('a.mp3'));
    });
    await waitFor(() => expect(result.current.pending?.name).toBe('a.mp3'));
    act(() => usePrevizStore.getState().setTimelineFrame(70));
    act(() => {
      b = result.current.addFile(file('b.mp3'));
    });
    await waitFor(() => expect(result.current.pending?.name).toBe('b.mp3'));

    first.resolve({ url: '/static/a.mp3' });
    await act(async () => {
      await a;
    });
    expect(result.current.pending?.name).toBe('b.mp3');

    second.resolve({ url: '/static/b.mp3' });
    await act(async () => {
      await b;
    });
    expect(result.current.pending).toBeNull();
    expect(usePrevizStore.getState().scene.timeline.audio).toMatchObject([
      { startFrame: 0, sourceName: 'a.mp3' },
      { startFrame: 70, sourceName: 'b.mp3' },
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

  it('shows the backend message instead of the ky error carrying the api url', async () => {
    // uploadFreezoneImage 直接用 apiClient，抛的是 ky 的 HTTPError：message 里是内部
    // 地址，给人看的那句挂在 .cause 上。非 2xx 走的都是这条路。
    const httpError = new Error(
      'Request failed with status code 413 Payload Too Large: ' +
        'POST http://host/api/v1/projects/demo/freezone/upload',
    );
    (httpError as { cause?: unknown }).cause = new Error('音频文件过大');
    uploadFreezoneAudio.mockRejectedValueOnce(httpError);
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(toast.error).toHaveBeenCalledWith('previz.audio.uploadFailed:音频文件过大');
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
    expect(uploadFreezoneAudio).not.toHaveBeenCalled();
  });

  it('refuses at the very end of the timeline without uploading', async () => {
    // setTimelineFrame 的上界是闭区间，播放头能停在 durationFrames 上，那里没有一帧可放。
    usePrevizStore.getState().setTimelineFrame(120);
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(toast.error).toHaveBeenCalledWith('previz.audio.noRoom');
    expect(uploadFreezoneAudio).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it('does not upload when the page has no project context', async () => {
    vi.mocked(readUrl).mockReturnValueOnce({ project: null, canvas: null });
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(uploadFreezoneAudio).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('previz.audio.noProject');
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
    expect(uploadFreezoneAudio).not.toHaveBeenCalled();
  });

  it('never uploads two imports under the same name', async () => {
    const { result } = renderHook(() => useAudioImport('previz-1'));
    // Date.now() 只精确到毫秒，两次导入在测试里完全可能落进同一毫秒。把钟握在手里，
    // 验的才是「时间走了名字就得换」，而不是这台机器这一趟跑得多快。
    let clock = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000));
    try {
      await act(() => result.current.addFile(file('take.mp3')));
      // 第一段占了 0~60 帧，播放头不挪开的话第二次会被「放不下」挡在上传之前。
      act(() => usePrevizStore.getState().setTimelineFrame(60));
      await act(() => result.current.addFile(file('take.mp3')));
    } finally {
      now.mockRestore();
    }
    const [first, second] = uploadFreezoneAudio.mock.calls.map((call) => call[2]);
    expect(second).toBeDefined();
    // 同名就是覆盖：第一段的 audioUrl 已经存进场景，它从此播的是第二段的声音。
    expect(first).not.toBe(second);
  });
});

describe('useAudioImport upstream node', () => {
  /** 让播放头压在一段既有音频里：两条上游路径都该在这儿被挡下来。 */
  function blockThePlayhead() {
    usePrevizStore
      .getState()
      .addAudioClip(
        { audioUrl: '/static/x.mp3', sourceName: 'x', durationMs: 4000, sourceNodeId: null },
        0,
      );
  }

  it('toasts instead of silently dropping a clip the store refuses', async () => {
    blockThePlayhead();
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() =>
      result.current.addUpstream({
        nodeId: 'audio-1',
        displayName: '旁白',
        audioUrl: '/static/vo.mp3',
        durationMs: 3000,
      }),
    );
    expect(toast.error).toHaveBeenCalledWith('previz.audio.noRoom');
    expect(usePrevizStore.getState().scene.timeline.audio).toHaveLength(1);
  });

  it('refuses before probing when there is no room, leaving no placeholder', async () => {
    blockThePlayhead();
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() =>
      result.current.addUpstream({
        nodeId: 'audio-1',
        displayName: '旁白',
        audioUrl: '/static/vo.mp3',
        durationMs: null,
      }),
    );
    expect(toast.error).toHaveBeenCalledWith('previz.audio.noRoom');
    expect(probeAudioDuration).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

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

  it('places the probed clip where the playhead was when it was picked', async () => {
    usePrevizStore.getState().setTimelineFrame(20);
    const probe = deferred<number>();
    probeAudioDuration.mockReturnValueOnce(probe.promise);
    const { result } = renderHook(() => useAudioImport('previz-1'));
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.addUpstream({
        nodeId: 'audio-1',
        displayName: '旁白',
        audioUrl: '/static/vo.mp3',
        durationMs: null,
      });
    });
    await waitFor(() => expect(result.current.pending?.name).toBe('旁白'));

    // 探测期间播放头挪走了，片段仍落在选中上游节点时的位置。
    act(() => usePrevizStore.getState().setTimelineFrame(90));
    probe.resolve(2000);
    await act(async () => {
      await done;
    });
    expect(usePrevizStore.getState().scene.timeline.audio).toMatchObject([
      { startFrame: 20, endFrame: 80 },
    ]);
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
