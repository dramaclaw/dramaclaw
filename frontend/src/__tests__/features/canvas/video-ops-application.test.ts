// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneVideoCompose = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const submitFreezoneAnalyzeVideoStory = vi.hoisted(() => vi.fn());
const submitFreezoneAudioSeparate = vi.hoisted(() => vi.fn());
const fetchFreezoneAudioSeparateResult = vi.hoisted(() => vi.fn());
const uploadFreezoneImage = vi.hoisted(() => vi.fn());
const uploadFreezoneVideo = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());
const ensureWebSafeVideo = vi.hoisted(() => vi.fn());
const captureVideoFrameBlob = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneVideoCompose,
  fetchFreezoneJobResult,
  submitFreezoneAnalyzeVideoStory,
  submitFreezoneAudioSeparate,
  fetchFreezoneAudioSeparateResult,
  uploadFreezoneImage,
  uploadFreezoneVideo,
}));
vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  awaitTaskCompletion,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));
vi.mock('@/features/canvas/application/videoTranscode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureWebSafeVideo,
}));
// 抽帧要一个能真解码的浏览器（jsdom 下 <video> 永远不会 loadeddata），整体替身掉，
// 只验截帧编排本身（抽帧 → 上传 → 建节点 → 连边 → 写标题）。
vi.mock('@/features/canvas/application/videoFrameBlob', () => ({ captureVideoFrameBlob }));

import { analyzeVideoStory } from '@/features/canvas/application/videoAnalyzeStory';
import {
  submitVideoClip,
  VIDEO_CLIP_NO_URL_MESSAGE,
} from '@/features/canvas/application/videoClipSubmit';
import { replaceNodeVideo } from '@/features/canvas/application/videoReplaceUpload';
import {
  classifyAudioSeparateResult,
  resolveSeparateBaseName,
  separateVideoAudio,
} from '@/features/canvas/application/videoSeparateAudio';
import {
  captureVideoFrameToNode,
  resolveCaptureSeekSec,
} from '@/features/canvas/application/videoCaptureFrame';
import { computeDisplayedVideoRect } from '@/features/canvas/nodes/shared/subtitleEraseBox';

function seedVideoNode(extraData: Record<string, unknown> = {}) {
  const nodes: CanvasNode[] = [
    {
      id: 'vid-1',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: {
        videoUrl: '/static/src.mp4',
        durationMs: 8000,
        displayName: '源视频',
        ...extraData,
      },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function nodeById(id: string | null | undefined) {
  return useCanvasStore.getState().nodes.find((node) => node.id === id);
}

function hasEdge(source: string, target: string | null | undefined) {
  return useCanvasStore
    .getState()
    .edges.some((edge) => edge.source === source && edge.target === target);
}

beforeEach(() => {
  vi.clearAllMocks();
  readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
  seedVideoNode();
});

describe('videoClipSubmit（剪辑提交编排）', () => {
  it('单轨单片段提交 → 下游建剪辑视频节点并连边', async () => {
    submitFreezoneVideoCompose.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_video_compose',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockResolvedValue({ url: '/static/clip.mp4' });

    const result = await submitVideoClip('vid-1', {
      sourceUrl: '/static/src.mp4',
      startMs: 1000,
      endMs: 3500,
      quality: '1080P',
    });

    expect(result.error).toBeNull();
    const payload = submitFreezoneVideoCompose.mock.calls[0][1];
    expect(payload.resolution).toBe('1080p');
    expect(payload.tracks[0].items[0]).toMatchObject({
      sourceUrl: '/static/src.mp4',
      sourceStart: 1,
      sourceEnd: 3.5,
    });
    expect(nodeById(result.nodeId)?.data).toMatchObject({
      videoUrl: '/static/clip.mp4',
      durationMs: 2500,
      displayName: '剪辑',
    });
    expect(hasEdge('vid-1', result.nodeId)).toBe(true);
  });

  it('非 1080P 源退回 720p；产物缺 url → 报错且不建节点', async () => {
    submitFreezoneVideoCompose.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_video_compose',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockResolvedValue({ url: null });

    const before = useCanvasStore.getState().nodes.length;
    const result = await submitVideoClip('vid-1', {
      sourceUrl: '/static/src.mp4',
      startMs: 0,
      endMs: 2000,
      quality: '480P',
    });

    expect(submitFreezoneVideoCompose.mock.calls[0][1].resolution).toBe('720p');
    expect(result).toEqual({ nodeId: null, error: VIDEO_CLIP_NO_URL_MESSAGE });
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });

  it('区间非法 / 缺 project → 直接返回，不提交', async () => {
    expect(
      await submitVideoClip('vid-1', { sourceUrl: '/static/src.mp4', startMs: 5, endMs: 5 }),
    ).toEqual({ nodeId: null, error: null });
    readUrl.mockReturnValue({ project: null, canvas: null });
    expect(
      await submitVideoClip('vid-1', { sourceUrl: '/static/src.mp4', startMs: 0, endMs: 100 }),
    ).toEqual({ nodeId: null, error: null });
    expect(submitFreezoneVideoCompose).not.toHaveBeenCalled();
  });
});

describe('videoAnalyzeStory（视频解析生成分镜故事）', () => {
  it('同步建 loading 故事节点 → 归一化结果回填，源节点清 isAnalyzing', async () => {
    submitFreezoneAnalyzeVideoStory.mockResolvedValue({ task_key: 'tk-story' });
    awaitTaskCompletion.mockResolvedValue({
      result: { shots: [{ start: 0, end: 2, description: '开场' }] },
    });

    const result = analyzeVideoStory('vid-1', { videoUrl: '/static/src.mp4', durationSec: 8 });
    expect(result).not.toBeNull();
    // 不等后端：故事节点此刻已经在画布上且是 loading 态。
    expect(nodeById(result?.nodeId)?.type).toBe(CANVAS_NODE_TYPES.videoStory);
    expect(nodeById(result?.nodeId)?.data).toMatchObject({
      sourceVideoUrl: '/static/src.mp4',
      isAnalyzing: true,
    });
    expect(nodeById('vid-1')?.data).toMatchObject({ isAnalyzing: true });
    expect(hasEdge('vid-1', result?.nodeId)).toBe(true);

    await result?.completion;
    expect(submitFreezoneAnalyzeVideoStory).toHaveBeenCalledWith('proj-1', {
      videoUrl: '/static/src.mp4',
      durationSec: 8,
    });
    expect(nodeById(result?.nodeId)?.data).toMatchObject({
      isAnalyzing: false,
      analysisError: null,
    });
    expect(nodeById('vid-1')?.data).toMatchObject({ isAnalyzing: false });
  });

  it('响应没有 task_key → 把响应本身当同步结果，不轮询', async () => {
    submitFreezoneAnalyzeVideoStory.mockResolvedValue({ shots: [] });
    const result = analyzeVideoStory('vid-1', { videoUrl: '/static/src.mp4' });
    await result?.completion;
    expect(awaitTaskCompletion).not.toHaveBeenCalled();
    expect(nodeById(result?.nodeId)?.data).toMatchObject({ isAnalyzing: false });
  });

  it('失败 → 错误同时写到故事节点与源节点', async () => {
    submitFreezoneAnalyzeVideoStory.mockRejectedValue(new Error('analyze boom'));
    const result = analyzeVideoStory('vid-1', { videoUrl: '/static/src.mp4' });
    await result?.completion;
    expect(nodeById(result?.nodeId)?.data).toMatchObject({
      isAnalyzing: false,
      analysisError: 'analyze boom',
    });
    expect(nodeById('vid-1')?.data).toMatchObject({ analysisError: 'analyze boom' });
  });

  it('缺 project → 返回 null，不建节点', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const before = useCanvasStore.getState().nodes.length;
    expect(analyzeVideoStory('vid-1', { videoUrl: '/static/src.mp4' })).toBeNull();
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });
});

describe('videoSeparateAudio（分离音视频）', () => {
  it('classify 优先取规范 *_url 字段', () => {
    expect(
      classifyAudioSeparateResult({
        audio_path: '/data/output/u/p/a.mp3',
        audio_url: '/static/projects/p/a.mp3',
        mute_video_url: '/static/projects/p/mute.mp4',
      }),
    ).toEqual({ audio: '/static/projects/p/a.mp3', video: '/static/projects/p/mute.mp4' });
  });

  it('classify 兜底遍历按扩展名挑，且优先已可直接访问的地址', () => {
    expect(
      classifyAudioSeparateResult({
        nested: { a: '/data/output/u/p/track.mp3', b: 'https://cdn/x/track.mp3' },
        v: 'https://cdn/x/silent.mp4',
      }),
    ).toEqual({ audio: 'https://cdn/x/track.mp3', video: 'https://cdn/x/silent.mp4' });
    expect(classifyAudioSeparateResult(null)).toEqual({ audio: null, video: null });
  });

  it('resolveSeparateBaseName：源文件名 > 展示名 > video，且去扩展名', () => {
    expect(resolveSeparateBaseName({ sourceFileName: 'a.mov', displayName: 'b' })).toBe('a');
    expect(resolveSeparateBaseName({ displayName: '镜头1' })).toBe('镜头1');
    expect(resolveSeparateBaseName({})).toBe('video');
  });

  it('成功 → 建音频 + 静音视频两个节点并连边，最后清 isSeparatingAv', async () => {
    seedVideoNode({ sourceFileName: 'shot.mp4' });
    submitFreezoneAudioSeparate.mockResolvedValue({ task_key: 'tk-av', job_id: 'job-av' });
    awaitTaskCompletion.mockResolvedValue({
      result: { audio_url: '/static/a.mp3', mute_video_url: '/static/mute.mp4' },
    });

    const result = await separateVideoAudio('vid-1', { sourceUrl: '/static/src.mp4' });

    expect(result.error).toBeNull();
    expect(nodeById(result.audioNodeId)?.type).toBe(CANVAS_NODE_TYPES.audio);
    expect(nodeById(result.audioNodeId)?.data).toMatchObject({
      audioUrl: '/static/a.mp3',
      displayName: 'shot_背景音',
    });
    expect(nodeById(result.videoNodeId)?.data).toMatchObject({
      videoUrl: '/static/mute.mp4',
      displayName: 'shot_无声',
      sourceFileName: 'shot_无声.mp4',
    });
    // 静音视频是 video→video，连得上。音频节点刻意不连边（用户拍板）：store 的
    // 上游白名单里 audio 只接受 textAnnotation，video→audio 建了也会被拒——与其
    // 悄悄调用一个注定失效的 addEdge，不如干脆不调用；音频节点仍正常建好、靠
    // findNodePosition 落在源附近，只是没有入边。
    expect(hasEdge('vid-1', result.videoNodeId)).toBe(true);
    expect(result.audioNodeId).not.toBeNull();
    expect(hasEdge('vid-1', result.audioNodeId)).toBe(false);
    expect(
      useCanvasStore.getState().edges.some((edge) => edge.target === result.audioNodeId),
    ).toBe(false);
    expect(nodeById('vid-1')?.data).toMatchObject({ isSeparatingAv: false });
  });

  it('SSE 结果缺地址 → 打 job result 接口兜底', async () => {
    submitFreezoneAudioSeparate.mockResolvedValue({ task_key: 'tk-av', job_id: 'job-av' });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneAudioSeparateResult.mockResolvedValue({
      audio_url: '/static/fb.mp3',
      mute_video_url: '/static/fb.mp4',
    });

    const result = await separateVideoAudio('vid-1', { sourceUrl: '/static/src.mp4' });
    expect(fetchFreezoneAudioSeparateResult).toHaveBeenCalledWith('proj-1', 'job-av');
    expect(nodeById(result.audioNodeId)?.data).toMatchObject({ audioUrl: '/static/fb.mp3' });
  });

  it('失败 → 返回 error，仍清掉 isSeparatingAv', async () => {
    submitFreezoneAudioSeparate.mockRejectedValue(new Error('av boom'));
    const result = await separateVideoAudio('vid-1', { sourceUrl: '/static/src.mp4' });
    expect(result.error).toBe('av boom');
    expect(nodeById('vid-1')?.data).toMatchObject({ isSeparatingAv: false });
  });
});

describe('videoCaptureFrame（截帧）', () => {
  it('resolveCaptureSeekSec：首帧 0 / 尾帧退 0.05s / 当前帧取播放器进度', () => {
    expect(resolveCaptureSeekSec('first', { currentTimeSec: 3, durationSec: 8 })).toBe(0);
    expect(resolveCaptureSeekSec('last', { durationSec: 8 })).toBeCloseTo(7.95);
    // 活的播放器没报时长时退回节点 data.durationMs 换算值。
    expect(resolveCaptureSeekSec('last', { durationSec: null, fallbackDurationSec: 4 })).toBeCloseTo(
      3.95,
    );
    // 两个时长都没有 → 交给 captureVideoFrameBlob 内部按实际 duration 夹到末尾。
    expect(resolveCaptureSeekSec('last', {})).toBe(Number.MAX_SAFE_INTEGER);
    expect(resolveCaptureSeekSec('current', { currentTimeSec: 2.5 })).toBe(2.5);
    expect(resolveCaptureSeekSec('current', { currentTimeSec: Number.NaN })).toBe(0);
  });

  it('抽帧 → 上传 → 建派生图片节点、连边、写标题；比例取源视频像素宽高', async () => {
    seedVideoNode({ widthPx: 1920, heightPx: 1080 });
    captureVideoFrameBlob.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    uploadFreezoneImage.mockResolvedValue({ url: '/static/frame.png' });

    const result = await captureVideoFrameToNode('vid-1', {
      videoUrl: '/static/src.mp4',
      seekSec: 0,
      displayName: '首帧',
    });

    expect(result.error).toBeNull();
    // 结果节点是 exportImage（非 upload）：upload 没有 target handle，之前
    // addEdge 静默失效；exportImage 有 target handle 且不受上游白名单限制，
    // 连边应该成功。
    expect(nodeById(result.nodeId)?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(nodeById(result.nodeId)?.data).toMatchObject({
      imageUrl: '/static/frame.png',
      displayName: '首帧',
    });
    expect(hasEdge('vid-1', result.nodeId)).toBe(true);
  });

  it('抽帧失败 → 返回 error，不建节点', async () => {
    captureVideoFrameBlob.mockRejectedValue(new Error('taint'));
    const before = useCanvasStore.getState().nodes.length;
    const result = await captureVideoFrameToNode('vid-1', {
      videoUrl: '/static/src.mp4',
      seekSec: 0,
      displayName: '首帧',
    });
    expect(result).toEqual({ nodeId: null, error: 'taint' });
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });
});

describe('videoReplaceUpload（替换视频）', () => {
  function videoFile(name = 'new.mp4') {
    return new File(['data'], name, { type: 'video/mp4' });
  }

  it('转码后上传 → 回写 videoUrl、清预览图与 isUploading', async () => {
    const transcoded = videoFile('new.h264.mp4');
    ensureWebSafeVideo.mockResolvedValue({ file: transcoded, transcoded: true });
    uploadFreezoneVideo.mockResolvedValue({ url: '/static/new.mp4' });
    const onTranscodedPreview = vi.fn();

    const result = await replaceNodeVideo('vid-1', videoFile(), { onTranscodedPreview });

    expect(result).toEqual({ url: '/static/new.mp4', error: null });
    // 源编码本浏览器可能解不了 → 本地预览换成转码产物。
    expect(onTranscodedPreview).toHaveBeenCalledWith(transcoded);
    expect(uploadFreezoneVideo).toHaveBeenCalledWith('proj-1', transcoded, 'new.h264.mp4');
    expect(nodeById('vid-1')?.data).toMatchObject({
      videoUrl: '/static/new.mp4',
      previewImageUrl: null,
      sourceFileName: 'new.mp4',
      isUploading: false,
    });
  });

  it('无需转码时不回调本地预览', async () => {
    const original = videoFile();
    ensureWebSafeVideo.mockResolvedValue({ file: original, transcoded: false });
    uploadFreezoneVideo.mockResolvedValue({ url: '/static/new.mp4' });
    const onTranscodedPreview = vi.fn();
    await replaceNodeVideo('vid-1', original, { onTranscodedPreview });
    expect(onTranscodedPreview).not.toHaveBeenCalled();
  });

  it('非视频文件 / 缺 project → 不上传；上传失败 → 清 isUploading 并返回 error', async () => {
    await replaceNodeVideo('vid-1', new File(['x'], 'a.txt', { type: 'text/plain' }));
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();

    readUrl.mockReturnValue({ project: null, canvas: null });
    await replaceNodeVideo('vid-1', videoFile());
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();

    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    ensureWebSafeVideo.mockResolvedValue({ file: videoFile(), transcoded: false });
    uploadFreezoneVideo.mockRejectedValue(new Error('upload boom'));
    const result = await replaceNodeVideo('vid-1', videoFile());
    expect(result).toEqual({ url: null, error: 'upload boom' });
    expect(nodeById('vid-1')?.data).toMatchObject({ isUploading: false });
  });
});

describe('computeDisplayedVideoRect（object-contain 坐标换算）', () => {
  it('视频比容器更宽 → 上下留黑边', () => {
    expect(computeDisplayedVideoRect(400, 400, 1920, 1080)).toEqual({
      left: 0,
      top: 87.5,
      width: 400,
      height: 225,
    });
  });

  it('视频比容器更高 → 左右留黑边', () => {
    expect(computeDisplayedVideoRect(400, 400, 1080, 1920)).toEqual({
      left: 87.5,
      top: 0,
      width: 225,
      height: 400,
    });
  });

  it('固有宽高未知 → 退化为整个容器', () => {
    expect(computeDisplayedVideoRect(400, 300, null, null)).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    });
  });
});
