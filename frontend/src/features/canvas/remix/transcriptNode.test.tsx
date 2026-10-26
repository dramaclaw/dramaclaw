import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  nodes: [
    { id: 'audio', data: { remixMedia: { media_path: 'narration.wav', media_kind: 'audio', url: '/media/narration.wav' } } },
    { id: 'transcript', data: { words: [], status: 'needs_review', artifactRef: null } },
  ] as Array<{ id: string; type?: string; data: Record<string, unknown> }>,
  edges: [{ source: 'audio', target: 'transcript' }],
  listeners: new Set<() => void>(),
  subscribe: (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
  updateNodeData: vi.fn((id: string, patch: Record<string, unknown>) => {
    const node = state.nodes.find((item) => item.id === id);
    if (node) node.data = { ...node.data, ...patch };
    for (const listener of state.listeners) listener();
  }),
  setSelectedNode: vi.fn(),
  addNode: vi.fn((type: string, _position: unknown, data: Record<string, unknown> = {}) => { state.nodes.push({ id: 'story', type, data }); return 'story'; }),
  addEdge: vi.fn((source: string, target: string) => { state.edges.push({ source, target }); return `${source}-${target}`; }),
  deleteNode: vi.fn(), findNodePosition: vi.fn(() => ({ x: 0, y: 0 })),
}));

vi.mock('@xyflow/react', () => ({ Handle: () => null, Position: { Left: 'left', Right: 'right' }, useUpdateNodeInternals: () => () => {} }));
vi.mock('@/features/canvas/ui/NodeHeader', () => ({ NodeHeader: () => null, NODE_HEADER_FLOATING_POSITION_CLASS: '' }));
vi.mock('@/features/canvas/ui/NodeResizeHandle', () => ({ NodeResizeHandle: () => null }));
vi.mock('@/stores/canvasStore', () => ({ useCanvasStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state, subscribe: state.subscribe }) }));
vi.mock('@/lib/url-params', () => ({ readUrl: () => ({ project: 'demo', canvas: 'default' }) }));
const joint = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiCall: joint }));
vi.mock('@/features/freezone/canvasSyncRuntime', () => ({ flushFreezoneCanvasRuntime: vi.fn(async () => true) }));
vi.mock('@/api/remix', () => ({
  attachRemixMedia: vi.fn(),
  submitRemixProcessAction: vi.fn(async () => ({ operation_id: 'operation-1' })),
  fetchRemixOperation: vi.fn(async () => ({ operation_id: 'operation-1', status: 'needs_confirmation', output_refs: [{ artifact_id: 'words-1', revision: 1 }] })),
  fetchRemixTaskStatus: vi.fn(async () => null),
  fetchRemixArtifact: vi.fn(async () => ({ id: 'words-1', revision: 1, schema: 'word_timeline.v1', upstream_refs: [{ artifact_id: 'script-1', revision: 3 }], payload: {
    schema: 'word_timeline.v1', media_hash: 'hash', language: 'zh', status: 'completed', transcript: '你好',
    words: [{ text: '你', start_char: 0, end_char: 1, start_us: 0, end_us: 500_000, confidence: 0.4 }, { text: '好', start_char: 1, end_char: 2, start_us: 500_000, end_us: 1_000_000, confidence: 0.9 }],
  } })),
}));
vi.mock('./transcriptArtifactApi', () => ({ reviseTranscriptArtifact: vi.fn(async () => ({ id: 'words-1', revision: 2 })) }));

import { TranscriptNode } from '../nodes/TranscriptNode';
import { fetchRemixArtifact, fetchRemixOperation, fetchRemixTaskStatus, submitRemixProcessAction } from '@/api/remix';
import { reviseTranscriptArtifact } from './transcriptArtifactApi';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { analyzeReferenceVideo } from '@/features/canvas/application/analyzeReferenceVideo';

const flowProps = { type: 'transcriptNode', zIndex: 0, draggable: true, dragging: false, selectable: true, deletable: true, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0 };

describe('TranscriptNode', () => {
  beforeEach(() => {
    state.listeners.clear();
    state.nodes[0] = { id: 'audio', data: { remixMedia: { media_path: 'narration.wav', media_kind: 'audio', url: '/media/narration.wav' } } };
    state.nodes.splice(2);
    state.edges.splice(0, state.edges.length, { source: 'audio', target: 'transcript' });
    state.nodes[1].data = { words: [], status: 'needs_review', artifactRef: null };
    state.updateNodeData.mockClear();
    vi.clearAllMocks();
  });
  it('shares a synchronous submission marker before React rerenders duplicate commands', async () => {
    let release!: (value: unknown) => void;
    vi.mocked(submitRemixProcessAction).mockReturnValueOnce(new Promise(resolve => { release = resolve; }) as never);
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    try {
      act(() => {
        canvasEventBus.publish('remix-node/action', { nodeId: 'transcript', action: 'transcribe' });
        canvasEventBus.publish('remix-node/action', { nodeId: 'transcript', action: 'transcribe' });
      });
      expect(submitRemixProcessAction).toHaveBeenCalledTimes(1);
      expect(state.nodes[1].data.transcriptSubmissionPending).toBeTruthy();
      expect(state.nodes[1].data.operationId).toBeFalsy();
    } finally {
      await act(async () => { release({ operation_id: 'operation-1' }); });
    }
    await waitFor(() => expect(state.nodes[1].data.transcriptSubmissionPending).toBeFalsy());
  });
  it('waits for actual component transcription before starting exact-reference analysis', async () => {
    const url = '/static/projects/demo/video.mp4';
    state.nodes[0] = { id: 'video', type: 'videoNode', data: { videoUrl: url, remixMedia: { media_path: 'video.mp4', media_hash: 'hash', media_kind: 'video', has_audio: true, url } } };
    state.nodes[1] = { id: 'transcript', type: 'transcriptNode', data: { words: [], status: 'needs_review', autoStartMode: 'transcribe', sourceMediaPath: 'video.mp4', sourceMediaHash: 'hash' } };
    state.edges.splice(0, state.edges.length, { source: 'video', target: 'transcript' });
    let release!: (value: unknown) => void;
    vi.mocked(submitRemixProcessAction).mockReturnValueOnce(new Promise(resolve => { release = resolve; }) as never);
    joint.mockResolvedValueOnce({ operation_id: 'analysis-op', status: 'completed', analysis_ref: { artifact_id: 'analysis', revision: 1 } });
    const originalFetch = vi.mocked(fetchRemixArtifact).getMockImplementation()!;
    vi.mocked(fetchRemixArtifact).mockImplementation(async (project, ref) => {
      if (ref.artifactId === 'analysis') return { schema: 'reference_analysis.v1', payload: { media_hash: 'sha256:hash', transcript_status: 'completed', transcript_ref: { artifact_id: 'words-1', revision: 1 }, story: { video_story: { summary: 'Actual words input' } } } } as never;
      const actual = await originalFetch(project, ref);
      return { ...actual, payload: { ...actual.payload, media_hash: 'sha256:hash' } } as never;
    });
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    const analysis = analyzeReferenceVideo('video', { videoUrl: url });
    try {
      await act(async () => { await Promise.resolve(); });
      expect(joint).not.toHaveBeenCalled();
      await act(async () => { release({ operation_id: 'operation-1' }); });
      await act(async () => { await analysis.completion; });
      expect(joint).toHaveBeenCalledOnce();
      expect(submitRemixProcessAction).toHaveBeenCalledOnce();
      expect(state.nodes.find(node => node.id === 'story')?.data.referenceTranscriptRef).toEqual(state.nodes[1].data.artifactRef);
    } finally {
      await act(async () => { release({ operation_id: 'operation-1' }); });
      vi.mocked(fetchRemixArtifact).mockImplementation(originalFetch);
    }
    await waitFor(() => expect(state.nodes[1].data.transcriptSubmissionPending).toBeFalsy());
  });
  it('releases a failed standalone submission marker so retry can enqueue', async () => {
    vi.mocked(submitRemixProcessAction).mockRejectedValueOnce(new Error('入队失败'));
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    act(() => canvasEventBus.publish('remix-node/action', { nodeId: 'transcript', action: 'transcribe' }));
    await waitFor(() => expect(screen.getByText('入队失败')).toBeTruthy());
    expect(state.nodes[1].data.transcriptSubmissionPending).toBeNull();
    expect(state.nodes[1].data.transcriptSubmissionRequest).toBeTruthy();
    const original = vi.mocked(submitRemixProcessAction).mock.calls[0][1];
    act(() => canvasEventBus.publish('remix-node/action', { nodeId: 'transcript', action: 'transcribe' }));
    await waitFor(() => expect(submitRemixProcessAction).toHaveBeenCalledTimes(2));
    expect(vi.mocked(submitRemixProcessAction).mock.calls[1][1]).toEqual(original);
  });
  it('reconciles a persisted lost standalone receipt by replaying its exact original admission', async () => {
    const request = { action: 'transcribe_media', mediaPath: 'narration.wav', language: 'auto', idempotencyKey: 'actual-prior-key', nodeRevision: 3 };
    state.nodes[1].data = { words: [], status: 'needs_review', transcriptSubmissionPending: 'actual-prior-key', transcriptSubmissionRequest: { project: 'demo', request } };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    await waitFor(() => expect(submitRemixProcessAction).toHaveBeenCalledWith('demo', request));
    await waitFor(() => expect(state.nodes[1].data.artifactRef).toEqual({ artifactId: 'words-1', revision: 1 }));
    expect(submitRemixProcessAction).toHaveBeenCalledTimes(1);
    expect(state.nodes[1].data.transcriptSubmissionPending).toBeNull();
    expect(state.nodes[1].data.transcriptSubmissionRequest).toBeNull();
  });
  it('joins a still-active local admission across remount without issuing another request', async () => {
    let release!: (value: unknown) => void;
    vi.mocked(submitRemixProcessAction).mockReturnValueOnce(new Promise(resolve => { release = resolve; }) as never);
    state.nodes[1].data.autoStartMode = 'transcribe';
    const view = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    view.unmount();
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    try { expect(submitRemixProcessAction).toHaveBeenCalledTimes(1); }
    finally { await act(async () => release({ operation_id: 'operation-1' })); }
    await waitFor(() => expect(state.nodes[1].data.artifactRef).toEqual({ artifactId: 'words-1', revision: 1 }));
    expect(submitRemixProcessAction).toHaveBeenCalledTimes(1);
  });
  it('bounds failed remount reconciliation to one attempt and leaves retry enabled with the original key', async () => {
    const request = { action: 'transcribe_media', mediaPath: 'narration.wav', language: 'auto', idempotencyKey: 'lost-response-key', nodeRevision: 1 };
    state.nodes[1].data = { words: [], status: 'needs_review', transcriptSubmissionPending: 'lost-response-key', transcriptSubmissionRequest: { project: 'demo', request } };
    vi.mocked(submitRemixProcessAction).mockRejectedValueOnce(new Error('回执读取失败'));
    const view = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    await waitFor(() => expect(screen.getByText('回执读取失败')).toBeTruthy());
    view.rerender(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    expect(submitRemixProcessAction).toHaveBeenCalledTimes(1);
    expect(state.nodes[1].data.transcriptSubmissionPending).toBeNull();
    expect(state.nodes[1].data.transcriptSubmissionRequest).toEqual({ project: 'demo', request });
    act(() => canvasEventBus.publish('remix-node/action', { nodeId: 'transcript', action: 'transcribe' }));
    await waitFor(() => expect(submitRemixProcessAction).toHaveBeenCalledTimes(2));
    expect(vi.mocked(submitRemixProcessAction).mock.calls[1][1]).toEqual(request);
  });
  it.each(['project', 'source'])('releases a remounted busy marker when its %s scope cannot be reconciled', async changed => {
    const request = { action: 'transcribe_media', mediaPath: 'narration.wav', language: 'auto', idempotencyKey: 'original-scope-key', nodeRevision: 1 };
    const saved = { project: changed === 'project' ? 'other-project' : 'demo', request };
    state.nodes[1].data = { words: [], status: 'needs_review', transcriptSubmissionPending: 'original-scope-key', transcriptSubmissionRequest: saved };
    if (changed === 'source') state.edges.splice(0);
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    await waitFor(() => expect(state.nodes[1].data.transcriptSubmissionPending).toBeNull());
    expect(submitRemixProcessAction).not.toHaveBeenCalled();
    expect(state.nodes[1].data.transcriptSubmissionRequest).toEqual(saved);
    expect(screen.getByText(changed === 'project' ? '原转写提交范围已变化，请核对已有任务' : '请先连接已上传的音频或带声音视频')).toBeTruthy();
  });

  it('starts transcription automatically when created by its source node', async () => {
    state.nodes[1].data = { words: [], status: 'needs_review', artifactRef: null, autoStartMode: 'transcribe' };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    await waitFor(() => expect(submitRemixProcessAction).toHaveBeenCalledWith('demo', expect.objectContaining({ action: 'transcribe_media', mediaPath: 'narration.wav', language: 'auto' })));
    expect(state.nodes[1].data.autoStartMode).toBeNull();
  });

  it('keeps transcription controls out of the node card', () => {
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    expect(screen.queryByRole('combobox', { name: '转写语言' })).toBeNull();
    expect(screen.queryByRole('button', { name: '开始转写' })).toBeNull();
    expect(screen.queryByRole('button', { name: '按脚本对齐' })).toBeNull();
  });

  it('keeps wheel scrolling inside the transcript content area', () => {
    const { container } = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    expect(container.querySelector('.ui-scrollbar')).toHaveClass('nowheel');
  });

  it('starts script alignment automatically only with both saved script and narration audio connected', async () => {
    state.nodes.push({ id: 'script', data: { remixScriptRef: { artifactId: 'script-1', revision: 3 } } });
    state.edges.push({ source: 'script', target: 'transcript' });
    state.nodes[1].data = { words: [], status: 'needs_review', artifactRef: null, autoStartMode: 'align' };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    await waitFor(() => expect(submitRemixProcessAction).toHaveBeenCalledWith('demo', expect.objectContaining({
      action: 'align_script', mediaPath: 'narration.wav', scriptRef: { artifactId: 'script-1', revision: 3 },
    })));
    expect(state.nodes[1].data.autoStartMode).toBeNull();
  });

  it('releases a failed worker task so transcription can be retried', async () => {
    vi.mocked(fetchRemixOperation).mockResolvedValueOnce({ operation_id: 'operation-1', status: 'pending', output_refs: [], task_type: 'remix_transcribe_media', task_scope: 'scope-1' } as never);
    vi.mocked(fetchRemixTaskStatus).mockResolvedValueOnce({ status: 'failed', error: 'NewAPI transcription failed' });
    state.nodes[1].data = { words: [], status: 'needs_review', artifactRef: null, operationId: 'operation-1' };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    await waitFor(() => expect(state.nodes[1].data).toMatchObject({ operationId: null, status: 'failed' }));
    expect(screen.getByText('NewAPI transcription failed')).toBeTruthy();
  });

  it('transcribes the connected audio and persists a word timeline reference', async () => {
    const { container, rerender } = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    act(() => canvasEventBus.publish('remix-node/action', { nodeId: 'transcript', action: 'transcribe' }));
    await waitFor(() => expect(submitRemixProcessAction).toHaveBeenCalledWith('demo', expect.objectContaining({ action: 'transcribe_media', mediaPath: 'narration.wav' })));
    await waitFor(() => expect(state.nodes[1].data.artifactRef).toEqual({ artifactId: 'words-1', revision: 1 }));
    rerender(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    expect(container.querySelector('p')?.textContent).toBe('你好');
    expect(screen.queryByDisplayValue('你')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开逐词校对（2）' }));
    expect(screen.getByDisplayValue('你')).toBeTruthy();
    expect(screen.getByText('低置信度')).toBeTruthy();
  });

  it('loads the full text for an existing transcript node', async () => {
    state.nodes[1].data = { words: [{ text: '你', startUs: 0, endUs: 500_000 }], status: 'completed', artifactRef: { artifactId: 'words-1', revision: 1 } };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    await waitFor(() => expect(state.nodes[1].data.transcriptText).toBe('你好'));
  });

  it('seeks from a word in the visible transcript while preserving punctuation', () => {
    state.nodes[1].data = {
      words: [
        { text: 'Hello', startUs: 1_200_000, endUs: 1_600_000 },
        { text: 'world', startUs: 2_100_000, endUs: 2_500_000 },
      ],
      transcriptText: 'Hello, world!', status: 'completed', artifactRef: null,
    };
    const { container } = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    const audio = container.querySelector('audio')!;

    expect(container.querySelector('p')?.textContent).toBe('Hello, world!');
    fireEvent.click(screen.getByRole('button', { name: '跳转到 world，00:02.100' }));

    expect(audio.currentTime).toBe(2.1);
  });

  it('shows provider sentences as separate cards and reviews one sentence at a time', () => {
    state.nodes[1].data = {
      words: [
        { text: '你吃榴莲', startUs: 0, endUs: 2_260_000, confidence: 0.9 },
        { text: '干嘛', startUs: 2_260_000, endUs: 3_160_000, confidence: 0.4 },
      ],
      segments: [
        { text: '你吃榴莲', startUs: 0, endUs: 2_260_000 },
        { text: '干嘛', startUs: 2_260_000, endUs: 3_160_000 },
      ],
      transcriptText: '你吃榴莲干嘛', status: 'completed', artifactRef: { artifactId: 'words-1', revision: 1 },
    };
    const { container } = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    const audio = container.querySelector('audio')!;

    expect(screen.getByRole('button', { name: '跳转到第 1 句，00:00.000' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '跳转到第 2 句，00:02.260' })).toBeTruthy();
    expect(screen.queryByDisplayValue('干嘛')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '跳转到第 2 句，00:02.260' }));
    expect(audio.currentTime).toBe(2.26);

    fireEvent.click(screen.getByRole('button', { name: '展开第 2 句逐词校对（1）' }));
    expect(screen.getByDisplayValue('干嘛')).toBeTruthy();
    expect(screen.queryByDisplayValue('你吃榴莲')).toBeNull();
    expect(screen.getByRole('button', { name: '收起第 2 句逐词校对（1）' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存校字' })).toBeTruthy();
  });

  it('keeps video playback usable in the compact transcript media panel', () => {
    state.nodes[0] = { id: 'video', type: 'videoNode', data: { remixMedia: { media_path: 'clip.mp4', media_kind: 'video', has_audio: true, url: '/media/clip.mp4' } } };
    state.edges.splice(0, state.edges.length, { source: 'video', target: 'transcript' });
    const { container } = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'duration', { configurable: true, value: 18 });
    fireEvent.loadedMetadata(video);

    let paused = true;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    const play = vi.spyOn(video, 'play').mockImplementation(async () => { paused = false; fireEvent.play(video); });
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; fireEvent.pause(video); });
    fireEvent.click(screen.getByRole('button', { name: '播放原片' }));
    expect(play).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByRole('slider', { name: '播放进度' }), { target: { value: '4.5' } });
    expect(video.currentTime).toBe(4.5);
    expect(screen.getByText('00:04 / 00:18')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '暂停原片' }));
    expect(pause).toHaveBeenCalledOnce();
  });

  it('highlights the word at the current playback time', () => {
    state.nodes[1].data = {
      words: [
        { text: 'Hello', startUs: 1_200_000, endUs: 1_600_000 },
        { text: 'world', startUs: 2_100_000, endUs: 2_500_000 },
      ],
      transcriptText: 'Hello world', status: 'completed', artifactRef: null,
    };
    const { container } = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    const audio = container.querySelector('audio')!;
    audio.currentTime = 2.2;
    fireEvent.timeUpdate(audio);

    expect(screen.getByRole('button', { name: '跳转到 world，00:02.100' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: '跳转到 Hello，00:01.200' }).hasAttribute('aria-current')).toBe(false);
  });

  it('follows short words between browser timeupdate events while playing', () => {
    state.nodes[1].data = {
      words: [
        { text: 'need', startUs: 13_005_000, endUs: 13_185_000 },
        { text: 'this', startUs: 13_185_000, endUs: 13_446_000 },
        { text: 'way', startUs: 13_446_000, endUs: 13_686_000 },
      ],
      transcriptText: 'need this way', status: 'completed', artifactRef: null,
    };
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      const { container, unmount } = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
      const audio = container.querySelector('audio')!;
      audio.currentTime = 13.05;
      fireEvent.play(audio);
      expect(screen.getByRole('button', { name: '跳转到 need，00:13.005' }).getAttribute('aria-current')).toBe('true');

      audio.currentTime = 13.23;
      act(() => { frames.shift()?.(0); });
      expect(screen.getByRole('button', { name: '跳转到 this，00:13.185' }).getAttribute('aria-current')).toBe('true');

      audio.currentTime = 13.5;
      act(() => { frames.shift()?.(0); });
      expect(screen.getByRole('button', { name: '跳转到 way，00:13.446' }).getAttribute('aria-current')).toBe('true');
      unmount();
      expect(cancelFrame).toHaveBeenCalled();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it('saves corrected words as a new artifact revision', async () => {
    state.nodes[1].data = { words: [{ text: '你', startUs: 0, endUs: 500_000, confidence: 0.4 }], status: 'completed', artifactRef: { artifactId: 'words-1', revision: 1 } };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    fireEvent.click(screen.getByRole('button', { name: '展开逐词校对（1）' }));
    fireEvent.change(screen.getByDisplayValue('你'), { target: { value: '您' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '仅校正同一发音和词边界，保留原时间' }));
    fireEvent.click(screen.getByRole('button', { name: '保存校字' }));
    await waitFor(() => expect(reviseTranscriptArtifact).toHaveBeenCalledWith('demo', { artifactId: 'words-1', revision: 1 }, expect.objectContaining({ transcript: '您好' }), [{ artifactId: 'script-1', revision: 3 }]));
    expect(state.nodes[1].data.artifactRef).toEqual({ artifactId: 'words-1', revision: 2 });
  });

  it('invalidates timing for an unconfirmed same-length replacement', async () => {
    state.nodes[1].data = { words: [{ text: '你', startUs: 0, endUs: 500_000 }], status: 'completed', artifactRef: { artifactId: 'words-1', revision: 1 } };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    fireEvent.click(screen.getByRole('button', { name: '展开逐词校对（1）' }));
    fireEvent.change(screen.getByDisplayValue('你'), { target: { value: '您' } });
    fireEvent.click(screen.getByRole('button', { name: '保存校字' }));
    await waitFor(() => expect(state.nodes[1].data.artifactRef).toBeNull());
    expect(state.nodes[1].data.pendingCorrectionText).toBe('您');
    expect(reviseTranscriptArtifact).not.toHaveBeenCalled();
  });

  it('invalidates timing for a changed phrase even with confirmation', async () => {
    state.nodes[1].data = { words: [{ text: '你', startUs: 0, endUs: 500_000 }], status: 'completed', artifactRef: { artifactId: 'words-1', revision: 1 } };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    fireEvent.click(screen.getByRole('button', { name: '展开逐词校对（1）' }));
    fireEvent.change(screen.getByDisplayValue('你'), { target: { value: '您好' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '仅校正同一发音和词边界，保留原时间' }));
    fireEvent.click(screen.getByRole('button', { name: '保存校字' }));
    await waitFor(() => expect(state.nodes[1].data.artifactRef).toBeNull());
    expect(reviseTranscriptArtifact).not.toHaveBeenCalled();
  });

  it('offers forced alignment when an upstream script artifact is connected', async () => {
    state.nodes.push({ id: 'script', data: { remixScriptRef: { artifactId: 'script-1', revision: 2 } } });
    state.edges.push({ source: 'script', target: 'transcript' });
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    act(() => canvasEventBus.publish('remix-node/action', { nodeId: 'transcript', action: 'align' }));
    await waitFor(() => expect(submitRemixProcessAction).toHaveBeenCalledWith('demo', expect.objectContaining({ action: 'align_script', mediaPath: 'narration.wav', scriptRef: { artifactId: 'script-1', revision: 2 } })));
  });

  it('invalidates old alignment when the connected script revision changes', async () => {
    state.nodes.push({ id: 'script', data: { remixScriptRef: { artifactId: 'script-1', revision: 3 } } });
    state.edges.push({ source: 'script', target: 'transcript' });
    state.nodes[1].data = { words: [{ text: '你', startUs: 0, endUs: 500_000 }], artifactRef: { artifactId: 'words-1', revision: 1 }, status: 'completed', alignedScriptRef: { artifactId: 'script-1', revision: 2 } };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    await waitFor(() => expect(state.nodes[1].data.artifactRef).toBeNull());
    expect(state.nodes[1].data.status).toBe('needs_review');
  });

  it('explains a script mismatch instead of reporting silence', async () => {
    vi.mocked(fetchRemixArtifact).mockResolvedValueOnce({
      id: 'words-1', revision: 1, schema: 'word_timeline.v1', payload: {
        status: 'script_mismatch', words: [], mismatch: { reason: 'ASR transcript does not match the script' },
      },
    } as never);
    state.nodes[1].data = { words: [], status: 'needs_review', artifactRef: null, operationId: 'operation-1', sourceMediaPath: 'narration.wav' };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);

    await waitFor(() => expect(state.nodes[1].data).toMatchObject({ operationId: null, status: 'needs_review' }));
    expect(screen.getByText(/脚本与音频不一致/)).toBeTruthy();
    expect(screen.queryByText(/没有识别到人声/)).toBeNull();
  });

  it('shows exact speech differences and keeps the audio and script revision for recovery', async () => {
    vi.mocked(fetchRemixArtifact).mockResolvedValueOnce({
      id: 'words-review', revision: 2, schema: 'word_timeline.v1', upstream_refs: [{ artifact_id: 'script-1', revision: 3 }], payload: {
        status: 'script_mismatch', script_revision: 3, words: [], mismatch: {
          reason: 'ASR omitted required script text',
          report: {
            character_coverage: 0.72,
            substitutions: [{ script_range: { text: '馋', start_char: 4, end_char: 5 }, asr_range: { text: '茶', start_char: 4, end_char: 5 }, confidence: 'low', provenance: 'asr_comparison' }],
            insertions: [],
            omissions: [{ script_range: { text: '马上出发', start_char: 12, end_char: 16 }, asr_range: { text: '', start_char: 8, end_char: 8 }, confidence: 'low', provenance: 'asr_comparison' }],
          },
        },
      },
    } as never);
    state.nodes.push({ id: 'script', data: { remixScriptRef: { artifactId: 'script-1', revision: 3 } } });
    state.edges.push({ source: 'script', target: 'transcript' });
    state.nodes[1].data = {
      words: [], status: 'needs_review', artifactRef: null, operationId: 'operation-1',
      sourceMediaPath: 'narration.wav', pendingScriptRef: { artifactId: 'script-1', revision: 3 },
    };
    const view = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);

    await waitFor(() => expect(state.nodes[1].data.operationId).toBeNull());
    expect(state.nodes[1].data).toMatchObject({
      sourceMediaPath: 'narration.wav',
      pendingScriptRef: { artifactId: 'script-1', revision: 3 },
      reviewArtifactRef: { artifactId: 'words-review', revision: 2 },
    });
    view.rerender(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    expect(screen.getByText(/馋.*→.*茶/)).toBeTruthy();
    expect(screen.getByText(/缺少.*马上出发/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '校对台词' }));
    expect(state.setSelectedNode).toHaveBeenCalledWith('script');
    fireEvent.click(screen.getByRole('button', { name: '重新对齐' }));
    await waitFor(() => expect(submitRemixProcessAction).toHaveBeenCalledWith('demo', expect.objectContaining({
      action: 'align_script', mediaPath: 'narration.wav', scriptRef: { artifactId: 'script-1', revision: 3 },
    })));
  });

  it('keeps the recovery route when forced alignment fails after an exact ASR match', () => {
    state.nodes.push({ id: 'script', data: { remixScriptRef: { artifactId: 'script-1', revision: 3 } } });
    state.edges.push({ source: 'script', target: 'transcript' });
    state.nodes[1].data = {
      words: [], status: 'needs_review', artifactRef: null, alignmentStale: true,
      pendingScriptRef: { artifactId: 'script-1', revision: 3 },
      speechMismatch: { reason: 'forced alignment left required script characters untimed', report: {
        substitutions: [], insertions: [], omissions: [], character_coverage: 1,
      }, untimed_script_ranges: [{ text: '好', start_char: 3, end_char: 4 }] },
    };

    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);

    expect(screen.getByRole('button', { name: '校对台词' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新对齐' })).toBeTruthy();
    expect(screen.getByText(/未对齐.*好.*3.*4/)).toBeTruthy();
  });

  it('keeps successful high-coverage differences available for review and realignment', async () => {
    vi.mocked(fetchRemixArtifact).mockResolvedValueOnce({
      id: 'words-1', revision: 2, schema: 'word_timeline.v1', upstream_refs: [{ artifact_id: 'script-1', revision: 3 }], payload: {
        status: 'completed', script_revision: 3, transcript: '今天想喝馋奶茶',
        match_report: {
          character_coverage: 0.9,
          substitutions: [{ script_range: { text: '馋', start_char: 4, end_char: 5 }, asr_range: { text: '茶', start_char: 4, end_char: 5 }, confidence: 'low', provenance: 'asr_comparison' }],
          insertions: [], omissions: [],
        },
        words: [{ text: '今', start_char: 0, end_char: 1, start_us: 0, end_us: 100_000 }],
      },
    } as never);
    state.nodes.push({ id: 'script', data: { remixScriptRef: { artifactId: 'script-1', revision: 3 } } });
    state.edges.push({ source: 'script', target: 'transcript' });
    state.nodes[1].data = {
      words: [], status: 'needs_review', artifactRef: null, operationId: 'operation-1',
      sourceMediaPath: 'narration.wav', pendingScriptRef: { artifactId: 'script-1', revision: 3 },
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);

    await waitFor(() => expect(state.nodes[1].data.artifactRef).toEqual({ artifactId: 'words-1', revision: 2 }));
    expect(state.nodes[1].data.speechMatchReport).toMatchObject({ character_coverage: 0.9 });
    view.rerender(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);
    expect(screen.getByText(/馋.*→.*茶/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '校对台词' }));
    expect(state.setSelectedNode).toHaveBeenCalledWith('script');
    fireEvent.click(screen.getByRole('button', { name: '重新对齐' }));
    await waitFor(() => expect(submitRemixProcessAction).toHaveBeenCalledWith('demo', expect.objectContaining({
      action: 'align_script', mediaPath: 'narration.wav', scriptRef: { artifactId: 'script-1', revision: 3 },
    })));
  });

  it('does not flag an exact successful alignment for review', () => {
    state.nodes[1].data = {
      words: [{ text: '你', startUs: 0, endUs: 100_000 }],
      transcriptText: '你', status: 'completed', artifactRef: { artifactId: 'words-1', revision: 2 },
      speechMatchReport: { character_coverage: 1, substitutions: [], insertions: [], omissions: [] },
    };

    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);

    expect(screen.queryByText('对齐覆盖不完整，请核对台词')).toBeNull();
    expect(screen.queryByRole('button', { name: '校对台词' })).toBeNull();
  });

  it('does not accept an alignment completed for a previous script revision', async () => {
    state.nodes.push({ id: 'script', data: { remixScriptRef: { artifactId: 'script-1', revision: 3 } } });
    state.edges.push({ source: 'script', target: 'transcript' });
    state.nodes[1].data = {
      words: [], status: 'needs_review', artifactRef: null, operationId: 'operation-1',
      sourceMediaPath: 'narration.wav', pendingScriptRef: { artifactId: 'script-1', revision: 2 },
    };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);

    await waitFor(() => expect(state.nodes[1].data.operationId).toBeNull());
    expect(state.nodes[1].data.artifactRef).toBeNull();
    expect(screen.getByText(/脚本已修改/)).toBeTruthy();
  });

  it('rejects an alignment artifact linked to a different script revision', async () => {
    state.nodes.push({ id: 'script', data: { remixScriptRef: { artifactId: 'script-1', revision: 2 } } });
    state.edges.push({ source: 'script', target: 'transcript' });
    state.nodes[1].data = {
      words: [], status: 'needs_review', artifactRef: null, operationId: 'operation-1',
      sourceMediaPath: 'narration.wav', pendingScriptRef: { artifactId: 'script-1', revision: 2 },
    };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);

    await waitFor(() => expect(state.nodes[1].data.operationId).toBeNull());
    expect(state.nodes[1].data.artifactRef).toBeNull();
    expect(screen.getByText(/对齐结果对应的脚本版本不一致/)).toBeTruthy();
  });

  it('accepts a completed alignment linked to the current script revision', async () => {
    vi.mocked(fetchRemixArtifact).mockResolvedValueOnce({
      id: 'words-1', revision: 1, schema: 'word_timeline.v1',
      upstream_refs: [{ artifact_id: 'script-1', revision: 2 }],
      payload: { status: 'completed', script_revision: 2, transcript: '你好', words: [
        { text: '你', start_char: 0, end_char: 1, start_us: 0, end_us: 500_000 },
        { text: '好', start_char: 1, end_char: 2, start_us: 500_000, end_us: 1_000_000 },
      ] },
    } as never);
    state.nodes.push({ id: 'script', data: { remixScriptRef: { artifactId: 'script-1', revision: 2 } } });
    state.edges.push({ source: 'script', target: 'transcript' });
    state.nodes[1].data = {
      words: [], status: 'needs_review', artifactRef: null, operationId: 'operation-1',
      sourceMediaPath: 'narration.wav', pendingScriptRef: { artifactId: 'script-1', revision: 2 },
    };
    render(<TranscriptNode {...flowProps} id="transcript" data={state.nodes[1].data as never} selected={false} />);

    await waitFor(() => expect(state.nodes[1].data.artifactRef).toEqual({ artifactId: 'words-1', revision: 1 }));
    expect(state.nodes[1].data.alignedScriptRef).toEqual({ artifactId: 'script-1', revision: 2 });
  });
});
