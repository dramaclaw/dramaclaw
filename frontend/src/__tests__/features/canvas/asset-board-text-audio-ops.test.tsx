// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

// 音频详情里的波形播放器会调 canvas 2D 上下文；jsdom 未实现，直接返回 null
// （播放器对 null 有早退兜底），避免测试里刷 "Not implemented" 噪音。
HTMLCanvasElement.prototype.getContext = vi.fn(
  () => null,
) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// 波形解码 fetch(src) 挂起不 settle：否则解码在测试结束后才 reject + console.warn，
// 环境拆除时会报 onUserConsoleLog pending（scrubber 不依赖解码结果，照常渲染）。
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

vi.mock('react-i18next', () => ({
  // 第二参数可能是插值对象；只有字符串才当默认文案（见 asset-board-video-ops 的说明）。
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));
vi.mock('@/features/canvas/hooks/useFreezoneImageModels', () => ({
  useFreezoneImageModels: () => ({ models: [] }),
}));
vi.mock('@/features/canvas/hooks/useFreezoneVideoModels', () => ({
  useFreezoneVideoModels: () => ({ models: [{ id: 'video-model-1' }] }),
}));

// 文本侧编排：验证「点按钮 → 正确入参传下去」，用永不 settle 的 promise 保住 busy 态。
const applyTextNodeMode = vi.hoisted(() => vi.fn());
const runTextImageToPrompt = vi.hoisted(() => vi.fn());
const submitTextToVideo = vi.hoisted(() => vi.fn());
const reanalyzeVideoStory = vi.hoisted(() => vi.fn());

vi.mock('@/features/canvas/application/textNodeModes', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyTextNodeMode,
}));
vi.mock('@/features/canvas/application/textImageToPrompt', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runTextImageToPrompt,
}));
vi.mock('@/features/canvas/application/textToVideoSubmit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitTextToVideo,
}));
vi.mock('@/features/canvas/application/videoAnalyzeStory', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reanalyzeVideoStory,
}));

function seedBoard(extra: CanvasNode[] = []) {
  const nodes: CanvasNode[] = [
    {
      id: 'txt-empty',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 0 },
      data: { displayName: '空文本', content: '' },
    } as CanvasNode,
    {
      id: 'txt-written',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 100 },
      data: { displayName: '已写文本', content: '雨夜旧车站' },
    } as CanvasNode,
    {
      id: 'story-1',
      type: CANVAS_NODE_TYPES.videoStory,
      position: { x: 0, y: 200 },
      data: {
        displayName: '分镜表',
        sourceVideoUrl: '/static/src.mp4',
        rows: [{ shotNumber: 1, duration: '2s', visualDescription: '旧的画面' }],
      },
    } as CanvasNode,
    ...extra,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

function openDetail(name: string) {
  render(<AssetBoardView visible onLocateNode={vi.fn()} />);
  fireEvent.click(screen.getAllByRole('button', { name })[0]);
}

describe('AssetBoard 详情文本操作（第二批）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedBoard();
  });

  // 文本详情的功能按钮（能力派生 / 反推提示词 / 生成视频 / 重新解析）已整体移除
  // ——故事板文本详情是只读阅读页，这些生成入口仍在工作流侧的节点上（用户要求）。
  // 保留的只有行表单元格编辑，见下面两条。

  it('分镜行表单元格：点击进入编辑、失焦回写 store', () => {
    openDetail('分镜表');

    fireEvent.click(within(detailPanel()).getByText('旧的画面'));
    const input = within(detailPanel()).getByRole('textbox');
    fireEvent.change(input, { target: { value: '新的画面' } });
    fireEvent.blur(input);

    const rows = useCanvasStore.getState().nodes.find((n) => n.id === 'story-1')?.data
      .rows as Array<Record<string, unknown>>;
    expect(rows[0].visualDescription).toBe('新的画面');
    // 同一行的其它列不受影响。
    expect(rows[0].duration).toBe('2s');
  });

  it('脚本行表单元格：回写落进 scriptResult.rows，title 等同级字段保留', () => {
    seedBoard([
      {
        id: 'script-1',
        type: CANVAS_NODE_TYPES.script,
        position: { x: 0, y: 400 },
        data: {
          displayName: '分镜脚本',
          scriptTitle: '第一幕',
          scriptResult: {
            title: '第一幕',
            rows: [{ shot_no: '1', duration: '3s', visual_description: '旧描述', dialogue: '喂' }],
          },
        },
      } as CanvasNode,
    ]);
    openDetail('分镜脚本');

    fireEvent.click(within(detailPanel()).getByText('旧描述'));
    const input = within(detailPanel()).getByRole('textbox');
    fireEvent.change(input, { target: { value: '新描述' } });
    fireEvent.blur(input);

    const result = useCanvasStore.getState().nodes.find((n) => n.id === 'script-1')?.data
      .scriptResult as { title: string; rows: Array<Record<string, unknown>> };
    expect(result.title).toBe('第一幕');
    expect(result.rows[0]).toMatchObject({
      shot_no: '1',
      duration: '3s',
      visual_description: '新描述',
      dialogue: '喂',
    });
  });
});

describe('AssetBoard 音频 chip / 详情表单', () => {
  function seedAudio(data: Record<string, unknown>) {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'audio-1',
          type: CANVAS_NODE_TYPES.audio,
          position: { x: 0, y: 0 },
          data: { displayName: '旁白', ...data },
        } as CanvasNode,
      ],
      [],
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('生成失败 → chip 上出红色失败角标（带完整错误文案）', () => {
    seedAudio({ audioUrl: null, generationError: '声线不可用' });
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    const badge = screen.getByLabelText('生成失败');
    expect(badge.getAttribute('title')).toBe('声线不可用');
  });

  it('生成中不显示失败角标（重试期间不该挂着上一次的红标）', () => {
    // generationTaskKey 必须给：setCanvasData 会把「没有可恢复句柄」的 isGenerating
    // 归零（避免中断的任务永远转圈），不给的话这个用例根本进不到生成中分支。
    seedAudio({
      audioUrl: null,
      generationError: '声线不可用',
      isGenerating: true,
      generationTaskKey: 'tk-1',
    });
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    expect(screen.queryByLabelText('生成失败')).toBeNull();
  });

  it('点音频 chip → 打开详情，出 TTS 档生成表单（文本 + 语气词 + 音色设置）', () => {
    seedAudio({ audioUrl: null, text: '你好', voiceLabel: '解说人 A' });
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '旁白' }));

    const detail = detailPanel();
    expect(within(detail).getByPlaceholderText('输入要合成的文本')).toBeTruthy();
    expect(within(detail).getByPlaceholderText(/紧张、压低声音/)).toBeTruthy();
    // 声线入口已收进底部控制行的图标按钮（对标 liblib footer），可及名走 title。
    expect(within(detail).getByRole('button', { name: /音色设置/ })).toBeTruthy();
    // 未生成过 → 提交键语义是「生成」而不是「重新生成」（aria-label）。
    expect(within(detail).getByRole('button', { name: /^生成$/ })).toBeTruthy();
  });

  it('music 档空节点详情：出高级设置（时长/纯音乐/段落时长），改动直接落 store', () => {
    // 已有 audioUrl 的音频详情只显示播放器、不挂表单；要测生成表单需用空音频节点。
    seedAudio({ audioUrl: null, audioKind: 'music', text: '电子乐' });
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '旁白' }));

    const detail = detailPanel();
    // 空节点 → 表单在场，music 档按钮语义是「生成」。
    expect(within(detail).getByRole('button', { name: /^生成$/ })).toBeTruthy();
    // TTS 专属字段在 music 档不出现。
    expect(within(detail).queryByPlaceholderText(/紧张、压低声音/)).toBeNull();

    fireEvent.click(within(detail).getByRole('button', { name: '高级设置' }));
    fireEvent.click(within(detail).getByRole('switch', { name: '强制纯音乐' }));

    const data = useCanvasStore.getState().nodes.find((n) => n.id === 'audio-1')?.data;
    expect(data?.forceInstrumental).toBe(false);
  });
});
