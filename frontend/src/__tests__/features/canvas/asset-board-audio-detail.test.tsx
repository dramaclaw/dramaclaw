// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { submitFreezoneAudioMusic, submitFreezoneAudioSpeech } from '@/api/ops';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  __resetAssetBoardAudioOpsStateForTest,
  inFlightAudioOps,
} from '@/features/canvas/ui/asset-board/AssetBoardAudioGenForm';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

// 波形播放器要 canvas 2D 上下文；jsdom 未实现 → 返回 null（播放器对 null 有早退兜底）。
HTMLCanvasElement.prototype.getContext = vi.fn(
  () => null,
) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// 波形播放器挂载后会 fetch(src) 解码波形；jsdom 里让它挂起不 settle —— 否则
// 解码在测试结束后才 reject 并 console.warn，会在环境拆除时报 onUserConsoleLog
// pending。scrubber（role=slider）不依赖解码结果，照常渲染。
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

// 提交要求 URL 里有 project（否则 useAudioGeneration.generate 直接早退）。
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'demo-project', canvas: 'default' }),
}));

// 永不 settle 的 promise：提交后保住生成中/在途态，便于断言编排入参与登记表。
const NEVER = new Promise<never>(() => {});
vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ops')>()),
  submitFreezoneAudioSpeech: vi.fn(() => NEVER),
  submitFreezoneAudioMusic: vi.fn(() => NEVER),
}));

function seed(nodes: CanvasNode[]) {
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function audioNode(data: Record<string, unknown>): CanvasNode {
  return {
    id: 'audio-1',
    type: CANVAS_NODE_TYPES.audio,
    position: { x: 0, y: 0 },
    data: { displayName: '背景音乐', ...data },
  } as CanvasNode;
}

function textNode(): CanvasNode {
  return {
    id: 'txt-1',
    type: CANVAS_NODE_TYPES.textAnnotation,
    position: { x: 0, y: 100 },
    data: { displayName: '锚点清单', content: '品牌：光影' },
  } as CanvasNode;
}

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

describe('AssetBoard 音频进主从详情', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAssetBoardAudioOpsStateForTest();
  });

  it('点音频 chip（已有资源）→ 中间波形播放器 + 底部可编辑生成表单；左侧文本栏，切换器在顶栏', () => {
    seed([audioNode({ audioUrl: '/static/a.mp3', text: '悠扬旋律' }), textNode()]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    // 三栏总览：文本栏在场。
    expect(screen.getByText('文本')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '背景音乐' }));

    const detail = detailPanel();
    // 中间：大波形播放器（scrubber）。
    expect(within(detail).getByRole('slider', { name: 'Audio waveform scrubber' })).toBeInTheDocument();
    // 底部：可编辑的生成表单（背景音乐节点按音乐语义展示）。
    expect(within(detail).getByPlaceholderText('描述想要的音乐：风格、乐器、节奏、氛围…')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: /重新生成/ })).toBeInTheDocument();
    // 定位入口已从详情面板整体移除。
    expect(within(detail).queryByRole('button', { name: /在画布中定位/ })).not.toBeInTheDocument();
    // 音频详情左侧 = 文本栏（切换器）；音频切换器在顶栏音频标签，不在左侧。图片/视频栏消失。
    expect(screen.getByText('音频')).toBeInTheDocument(); // 顶栏音频标签
    expect(screen.getByText('文本')).toBeInTheDocument(); // 左侧文本栏切换器
    expect(screen.getByText('锚点清单')).toBeInTheDocument();
    expect(screen.queryByText('图片')).not.toBeInTheDocument();
    expect(screen.queryByText('视频')).not.toBeInTheDocument();
  });

  it('空音频节点（无 audioUrl）→ 详情中间显示占位，下方仍挂表单（可从零生成）', () => {
    seed([audioNode({ audioUrl: null, text: '悠扬旋律' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '背景音乐' }));

    const detail = detailPanel();
    // 无波形（没有 src），走空占位文案。
    expect(within(detail).queryByRole('slider', { name: 'Audio waveform scrubber' })).not.toBeInTheDocument();
    expect(within(detail).getByText('待确认后生成')).toBeInTheDocument();
    // 表单照旧在，按钮语义是「生成」（未生成过）。
    expect(within(detail).getByPlaceholderText('描述想要的音乐：风格、乐器、节奏、氛围…')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: /^生成$/ })).toBeInTheDocument();
  });

  it('背景音乐填了文本 → 点「生成」走音乐生成提交，在途登记表记 generate', async () => {
    seed([audioNode({ audioUrl: null, text: '你好' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '背景音乐' }));

    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^生成$/ }));

    await waitFor(() => expect(submitFreezoneAudioMusic).toHaveBeenCalled());
    const [project, payload] = vi.mocked(submitFreezoneAudioMusic).mock.calls[0];
    expect(project).toBe('demo-project');
    expect(payload.prompt).toBe('你好');
    // 详情按 key=nodeId 重挂也不重复提交：在途态放模块级登记表。
    await waitFor(() => expect(inFlightAudioOps.get('audio-1')).toBe('generate'));
  });

  it('语音生成只提交可朗读正文，不朗读时长和音效说明', async () => {
    seed([audioNode({
      displayName: '旁白',
      audioUrl: null,
      text: '【时长】79s\n【旁白】（低沉）真正的旁白。\n【音效】雷声',
      speechMode: 'clone',
      voiceAvailable: true,
      voiceRef: { scope: 'user_custom', voiceId: 'voice-1' },
    })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '旁白' }));

    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^生成$/ }));

    await waitFor(() => expect(submitFreezoneAudioSpeech).toHaveBeenCalled());
    const [, payload] = vi.mocked(submitFreezoneAudioSpeech).mock.calls[0];
    expect(payload.text).toBe('真正的旁白。');
  });

  it('故事板隐藏（visible=false）→ 命令波形播放器暂停内部 <audio>', () => {
    const pauseSpy = vi
      .spyOn(window.HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => {});
    seed([audioNode({ audioUrl: '/static/a.mp3', text: '悠扬旋律' })]);
    const { rerender } = render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '背景音乐' }));
    expect(within(detailPanel()).getByRole('slider', { name: 'Audio waveform scrubber' })).toBeInTheDocument();

    // 保活隐藏：视图切走后播放器仍挂载，但 paused=!visible 命令内部 <audio> 停下。
    pauseSpy.mockClear();
    rerender(<AssetBoardView visible={false} onLocateNode={vi.fn()} />);
    expect(pauseSpy).toHaveBeenCalled();

    pauseSpy.mockRestore();
  });

  it('切换音频详情 A→B → 波形播放器按 key 换实例（防 isPlaying 状态串）', () => {
    seed([
      { id: 'audio-1', type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 }, data: { displayName: '背景音乐', audioUrl: '/static/a.mp3' } } as CanvasNode,
      { id: 'audio-2', type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 100 }, data: { displayName: '旁白', audioUrl: '/static/b.mp3' } } as CanvasNode,
    ]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    // 打开 A 的详情，拿到当前 <audio> DOM 节点。
    fireEvent.click(screen.getByRole('button', { name: '背景音乐' }));
    const audioA = detailPanel().querySelector('audio');
    expect(audioA?.getAttribute('src')).toBe('/static/a.mp3');

    // 在左侧音频条点 B → 切换详情。key={node.id} 强制换实例：<audio> 应是全新 DOM
    // 节点（若缺 key，React 只改同一 <audio> 的 src，isPlaying 状态会串到 B）。
    fireEvent.click(screen.getByRole('button', { name: '旁白' }));
    const audioB = detailPanel().querySelector('audio');
    expect(audioB?.getAttribute('src')).toBe('/static/b.mp3');
    expect(audioB).not.toBe(audioA);
  });

  it('× 关闭详情 → 回三栏布局', () => {
    seed([audioNode({ audioUrl: '/static/a.mp3', text: '悠扬旋律' }), textNode()]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '背景音乐' }));
    expect(screen.queryByRole('region', { name: '资产详情' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));

    expect(screen.queryByRole('region', { name: '资产详情' })).not.toBeInTheDocument();
    expect(screen.getByText('文本')).toBeInTheDocument();
  });

  it('音频切换器在顶栏音频标签：进详情后 chip 仍可点切换（无内联操作面开关）', () => {
    seed([audioNode({ audioUrl: '/static/a.mp3', text: '悠扬旋律' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    // 顶栏音频标签只有大方块 chip，没有旧的「音频操作」开关。
    expect(screen.queryByRole('button', { name: /音频操作/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '背景音乐' }));
    // 进详情后音频切换器留在顶栏音频标签：仍是一处「音频」标题（顶栏标签），左侧是文本栏。
    expect(screen.getAllByText('音频')).toHaveLength(1);
    // 依然没有内联操作面开关（表单已进详情）。
    expect(screen.queryByRole('button', { name: /音频操作/ })).not.toBeInTheDocument();
    // 音频切换器仍可点（chip 保留在顶栏）。
    expect(screen.getByRole('button', { name: '背景音乐' })).toBeInTheDocument();
  });
});
