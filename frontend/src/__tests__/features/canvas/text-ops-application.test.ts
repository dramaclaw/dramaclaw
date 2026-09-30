// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const ensureBackendImageUrl = vi.hoisted(() => vi.fn());
const submitFreezoneReversePrompt = vi.hoisted(() => vi.fn());
const fetchFreezoneReversePromptResult = vi.hoisted(() => vi.fn());
const submitFreezoneVideoGen = vi.hoisted(() => vi.fn());
const submitFreezoneAnalyzeVideoStory = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureBackendImageUrl,
  submitFreezoneReversePrompt,
  fetchFreezoneReversePromptResult,
  submitFreezoneVideoGen,
  submitFreezoneAnalyzeVideoStory,
}));
vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  awaitTaskCompletion,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));

import {
  resolveTextNodeUpstreamImageUrl,
  resolveUpstreamImageUrl,
  runTextImageToPrompt,
} from '@/features/canvas/application/textImageToPrompt';
import {
  applyTextNodeMode,
  TEXT_TO_MUSIC_DEFAULT_CONTENT,
} from '@/features/canvas/application/textNodeModes';
import { submitTextToVideo } from '@/features/canvas/application/textToVideoSubmit';
import { reanalyzeVideoStory } from '@/features/canvas/application/videoAnalyzeStory';

function nodeById(id: string | null | undefined) {
  return useCanvasStore.getState().nodes.find((node) => node.id === id);
}

function hasEdge(source: string, target: string | null | undefined) {
  return useCanvasStore
    .getState()
    .edges.some((edge) => edge.source === source && edge.target === target);
}

function seedTextNode(extraData: Record<string, unknown> = {}) {
  const nodes: CanvasNode[] = [
    {
      id: 'txt-1',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 400, y: 200 },
      data: { content: '雨夜旧车站', ...extraData },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

beforeEach(() => {
  vi.clearAllMocks();
  readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
  seedTextNode();
});

describe('textNodeModes（文本节点能力派生）', () => {
  it('textToVideo：切 mode + 下游建视频节点并连边，正文带进 prompt', () => {
    const result = applyTextNodeMode('txt-1', 'textToVideo');

    expect(result.enterEdit).toBe(false);
    expect(nodeById('txt-1')?.data.mode).toBe('textToVideo');
    expect(nodeById(result.spawnedNodeId)).toMatchObject({
      type: CANVAS_NODE_TYPES.video,
      data: expect.objectContaining({ genMode: 'textToVideo', prompt: '雨夜旧车站' }),
    });
    expect(hasEdge('txt-1', result.spawnedNodeId)).toBe(true);
  });

  it('imageToPrompt：上游建仅收图片的上传节点，连边方向是 上传 → 文本', () => {
    const result = applyTextNodeMode('txt-1', 'imageToPrompt');

    expect(nodeById('txt-1')?.data.mode).toBe('imageToPrompt');
    expect(nodeById(result.spawnedNodeId)).toMatchObject({
      type: CANVAS_NODE_TYPES.upload,
      data: expect.objectContaining({ imageOnly: true }),
    });
    // 上游落在文本节点左侧（x 更小），方向与下游派生相反。
    expect(nodeById(result.spawnedNodeId)!.position.x).toBeLessThan(400);
    expect(hasEdge(result.spawnedNodeId!, 'txt-1')).toBe(true);
  });

  it('textToMusic / textToMusicGen：派生音频节点，音乐档还会把本节点切回 writing 并预填描述', () => {
    const speech = applyTextNodeMode('txt-1', 'textToMusic');
    expect(nodeById(speech.spawnedNodeId)).toMatchObject({
      type: CANVAS_NODE_TYPES.audio,
      data: expect.objectContaining({ audioKind: 'speech' }),
    });
    expect(nodeById('txt-1')?.data.mode).toBe('textToMusic');

    seedTextNode();
    const music = applyTextNodeMode('txt-1', 'textToMusicGen');
    expect(music.enterEdit).toBe(true);
    expect(nodeById(music.spawnedNodeId)?.data.audioKind).toBe('music');
    // 派生在前、回写在后：文本节点回到 writing + 关 picker + 预填默认音乐描述。
    expect(nodeById('txt-1')?.data).toMatchObject({
      mode: 'writing',
      pickerDismissed: true,
      content: TEXT_TO_MUSIC_DEFAULT_CONTENT,
    });
  });

  it('writing：只切 mode，不派生任何节点', () => {
    const before = useCanvasStore.getState().nodes.length;
    const result = applyTextNodeMode('txt-1', 'writing');

    expect(result).toEqual({ spawnedNodeId: null, enterEdit: true });
    expect(useCanvasStore.getState().nodes).toHaveLength(before);
  });
});

describe('textImageToPrompt（图片反推提示词）', () => {
  it('resolveUpstreamImageUrl 回退顺序：imageUrl → previewImageUrl → referenceImageUrl', () => {
    expect(resolveUpstreamImageUrl({ imageUrl: 'a', previewImageUrl: 'b' })).toBe('a');
    expect(resolveUpstreamImageUrl({ previewImageUrl: 'b', referenceImageUrl: 'c' })).toBe('b');
    expect(resolveUpstreamImageUrl({ referenceImageUrl: 'c' })).toBe('c');
    expect(resolveUpstreamImageUrl({})).toBeNull();
    expect(resolveUpstreamImageUrl(undefined)).toBeNull();
  });

  it('提交成功 → 反推结果回填到文本节点自己的 content（不建新节点）', async () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'img-1',
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { previewImageUrl: '/static/ref.png' },
        } as CanvasNode,
        {
          id: 'txt-1',
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 400, y: 0 },
          data: { mode: 'imageToPrompt' },
        } as CanvasNode,
      ],
      [{ id: 'e1', source: 'img-1', target: 'txt-1' }],
    );
    expect(resolveTextNodeUpstreamImageUrl('txt-1')).toBe('/static/ref.png');

    ensureBackendImageUrl.mockResolvedValue('/static/ref.png');
    submitFreezoneReversePrompt.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_image_reverse_prompt',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneReversePromptResult.mockResolvedValue({ prompt: '一张雨夜照片' });

    const before = useCanvasStore.getState().nodes.length;
    const result = await runTextImageToPrompt('txt-1');

    expect(result).toEqual({ prompt: '一张雨夜照片', error: null });
    expect(useCanvasStore.getState().nodes).toHaveLength(before);
    expect(nodeById('txt-1')?.data).toMatchObject({
      content: '一张雨夜照片',
      isGenerating: false,
      generationStartedAt: null,
    });
  });

  it('无上游图 → 直接报错，不提交也不置 loading 态', async () => {
    const result = await runTextImageToPrompt('txt-1');

    expect(result.error).toBe('上游没有可反推的图片');
    expect(submitFreezoneReversePrompt).not.toHaveBeenCalled();
    expect(nodeById('txt-1')?.data.isGenerating).not.toBe(true);
  });
});

describe('textToVideoSubmit（文生视频提交）', () => {
  function seedTextToVideoGraph(videoData: Record<string, unknown> = {}) {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'txt-1',
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: { mode: 'textToVideo', content: '雨夜旧车站' },
        } as CanvasNode,
        {
          id: 'vid-1',
          type: CANVAS_NODE_TYPES.video,
          position: { x: 600, y: 0 },
          data: { genMode: 'textToVideo', ...videoData },
        } as CanvasNode,
      ],
      [{ id: 'e1', source: 'txt-1', target: 'vid-1' }],
    );
  }

  it('参数读自下游视频节点，产物回填该节点', async () => {
    seedTextToVideoGraph({
      aspectRatio: '9:16',
      quality: '1080P',
      durationSec: 8,
      generateAudio: true,
      model: 'model-x',
    });
    submitFreezoneVideoGen.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_video_gen',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({ result: { video_url: '/static/out.mp4' } });

    const result = await submitTextToVideo('txt-1', {
      content: '雨夜旧车站',
      fallbackModelId: 'fallback-model',
    });

    expect(result).toEqual({ nodeIds: ['vid-1'], error: null });
    expect(submitFreezoneVideoGen.mock.calls[0][1]).toMatchObject({
      prompt: '雨夜旧车站',
      aspectRatio: '9:16',
      resolution: '1080p',
      durationSeconds: 8,
      generateAudio: true,
      model: 'model-x',
      nodeId: 'vid-1',
    });
    expect(nodeById('vid-1')?.data).toMatchObject({
      videoUrl: '/static/out.mp4',
      isGenerating: false,
    });
  });

  it('视频节点没选模型 → 用调用方给的兜底 id；缺省画幅/画质走 16:9 / 720p', async () => {
    // model 显式置空串（节点默认值会填一个模型 id，不清掉走不到兜底分支）。
    seedTextToVideoGraph({ model: '' });
    submitFreezoneVideoGen.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_video_gen',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({ result: { url: '/static/out.mp4' } });

    await submitTextToVideo('txt-1', {
      content: '雨夜旧车站',
      fallbackModelId: 'fallback-model',
    });

    expect(submitFreezoneVideoGen.mock.calls[0][1]).toMatchObject({
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 5,
      model: 'fallback-model',
    });
  });

  it('空正文不提交；下游没有视频节点 → 报错不提交', async () => {
    seedTextToVideoGraph();
    expect(
      await submitTextToVideo('txt-1', { content: '   ', fallbackModelId: 'm' }),
    ).toEqual({ nodeIds: [], error: null });

    seedTextNode({ mode: 'textToVideo' });
    const orphan = await submitTextToVideo('txt-1', { content: 'x', fallbackModelId: 'm' });
    expect(orphan.error).toBe('下游没有可承载产物的视频节点');
    expect(submitFreezoneVideoGen).not.toHaveBeenCalled();
  });

  it('提交失败 → 清 loading 态并把首个错误原因带回调用方', async () => {
    seedTextToVideoGraph();
    submitFreezoneVideoGen.mockRejectedValue(new Error('额度不足'));

    const result = await submitTextToVideo('txt-1', {
      content: '雨夜旧车站',
      fallbackModelId: 'm',
    });

    expect(result.error).toBe('额度不足');
    expect(nodeById('vid-1')?.data).toMatchObject({
      isGenerating: false,
      generationStartedAt: null,
    });
  });
});

describe('reanalyzeVideoStory（视频故事重新解析）', () => {
  function seedStoryNode(data: Record<string, unknown> = {}) {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'story-1',
          type: CANVAS_NODE_TYPES.videoStory,
          position: { x: 0, y: 0 },
          data: {
            sourceVideoUrl: '/static/src.mp4',
            rows: [{ shotNumber: 1, visualDescription: '旧的' }],
            ...data,
          },
        } as CanvasNode,
      ],
      [],
    );
  }

  it('复用当前故事节点：不建新节点、不连新边，结果原地覆盖', async () => {
    seedStoryNode();
    submitFreezoneAnalyzeVideoStory.mockResolvedValue({
      task_key: 'tk',
      job_id: 'job-1',
    });
    awaitTaskCompletion.mockResolvedValue({
      result: { shots: [{ shot_number: 1, visual_description: '新的' }] },
    });

    const before = useCanvasStore.getState().nodes.length;
    const result = reanalyzeVideoStory('story-1');
    expect(result?.nodeId).toBe('story-1');
    // 同步阶段就该置成解析中（详情按钮据此转 spinner）。
    expect(nodeById('story-1')?.data.isAnalyzing).toBe(true);
    await result?.completion;

    expect(useCanvasStore.getState().nodes).toHaveLength(before);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
    expect(submitFreezoneAnalyzeVideoStory.mock.calls[0][1]).toMatchObject({
      videoUrl: '/static/src.mp4',
    });
    expect(nodeById('story-1')?.data).toMatchObject({
      isAnalyzing: false,
      analysisError: null,
    });
    expect((nodeById('story-1')?.data.rows as unknown[]).length).toBeGreaterThan(0);
  });

  it('节点没记住片源 → 返回 null，不提交', () => {
    seedStoryNode({ sourceVideoUrl: null });

    expect(reanalyzeVideoStory('story-1')).toBeNull();
    expect(submitFreezoneAnalyzeVideoStory).not.toHaveBeenCalled();
  });

  it('失败 → 错误写回故事节点自身并清 loading 态', async () => {
    seedStoryNode();
    submitFreezoneAnalyzeVideoStory.mockRejectedValue(new Error('解析服务不可用'));

    const result = reanalyzeVideoStory('story-1');
    await result?.completion;

    expect(nodeById('story-1')?.data).toMatchObject({
      isAnalyzing: false,
      analysisError: '解析服务不可用',
    });
  });
});
