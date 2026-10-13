// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { submitFreezoneVideoGen } from '@/api/ops';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

// 视频表单的按钮标题走 i18n key（不像图片侧写死中文），这里只把用到的几条兑成
// public/locales/zh 里的真实文案，断言才读得懂。
const ZH = vi.hoisted(() => ({
  'node.videoNode.submit': '提交',
  'node.videoNode.submitBusy': '生成中，请稍候',
  'node.videoNode.placeholder': '根据文字描述生成视频。',
}) as Record<string, string>);

vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 第二参数可能是插值对象（如 t(key, { count })），只有字符串才当默认文案用，
    // 否则会把对象当成 React 子节点渲染出去。
    t: (key: string, fallback?: unknown) =>
      ZH[key] ?? (typeof fallback === 'string' ? fallback : key),
  }),
}));

// 算力询价走 react-query，测试树里没有 QueryClientProvider —— 直接短路。
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

// 提交要求 URL 里有 project（否则 handleSubmit 直接早退）。
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'demo-project', canvas: 'default' }),
}));

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ops')>()),
  fetchFreezoneVideoModels: vi.fn(async () => [
    {
      id: 'huimeng/test-video',
      providerId: 'huimeng',
      apiModel: 'test_video_api',
      label: '测试视频模型',
    },
  ]),
  fetchFreezoneVideoCameraTemplates: vi.fn(async () => []),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneVideoGen: vi.fn(async () => ({
    task_key: 'task-1',
    task_type: 'freezone_video_gen',
    job_id: 'job-1',
  })),
  fetchFreezoneJobResult: vi.fn(async () => ({ url: '/static/out.mp4' })),
}));

vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/tasks')>()),
  awaitTaskCompletion: vi.fn(async () => ({
    result: { video_url: '/static/out.mp4' },
  })),
}));

function seed(nodes: CanvasNode[]) {
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function emptyVideoNode(overrides: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'vid-1',
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: {
      videoUrl: null,
      prompt: '',
      aspectRatio: '16:9',
      quality: '720P',
      displayName: '视频节点 1',
      ...overrides,
    },
  } as CanvasNode;
}

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

function openDetail(name: string) {
  render(<AssetBoardView visible onLocateNode={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('故事板详情 · 视频生成表单', () => {
  beforeEach(() => {
    vi.mocked(submitFreezoneVideoGen).mockClear();
  });

  it('空 video 节点：媒体区显示「待确认后生成」占位，下方挂完整生成表单', () => {
    seed([emptyVideoNode()]);
    openDetail('视频节点 1');

    const detail = detailPanel();
    expect(within(detail).getAllByText('待确认后生成').length).toBeGreaterThan(0);
    // 生成条：运镜 / 资产库 chips + 提示词输入 + 提交。
    expect(within(detail).getByRole('button', { name: /资产库/ })).toBeInTheDocument();
    expect(
      detail.querySelector('[data-placeholder="根据文字描述生成视频。"]'),
    ).not.toBeNull();
    expect(within(detail).getByRole('button', { name: '提交' })).toBeInTheDocument();
  });

  it('提示词为空且无上游文本 → 提交按钮禁用', () => {
    seed([emptyVideoNode()]);
    openDetail('视频节点 1');

    expect(within(detailPanel()).getByRole('button', { name: '提交' })).toBeDisabled();
  });

  it('有提示词 → 点提交走真实提交链路（submitFreezoneVideoGen 收到该 prompt）', async () => {
    seed([emptyVideoNode({ prompt: '雪夜里发光的小猫在屋顶漫步' })]);
    openDetail('视频节点 1');

    const submit = within(detailPanel()).getByRole('button', { name: '提交' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(submitFreezoneVideoGen).toHaveBeenCalled());
    const [project, payload] = vi.mocked(submitFreezoneVideoGen).mock.calls[0];
    expect(project).toBe('demo-project');
    expect(payload.prompt).toBe('雪夜里发光的小猫在屋顶漫步');
    expect(payload.nodeId).toBe('vid-1');
    expect(payload.genMode).toBe('textToVideo');
  });

  it('已有产物的 video 节点仍挂表单，且不再重复渲染只读提示词块', () => {
    seed([
      emptyVideoNode({
        videoUrl: '/static/done.mp4',
        prompt: '已经出片的提示词',
      }),
    ]);
    openDetail('视频节点 1');

    const detail = detailPanel();
    expect(within(detail).getByRole('button', { name: '提交' })).toBeInTheDocument();
    // 只读展示块的小标题不出现——提示词只由表单里的输入框承载一份。
    expect(within(detail).queryByText('提示词')).not.toBeInTheDocument();
    expect(within(detail).getAllByText('已经出片的提示词')).toHaveLength(1);
  });

  it('videoCompose 节点详情不出生成表单（它走剪辑合成，不是生成节点）', () => {
    seed([
      {
        id: 'compose-1',
        type: CANVAS_NODE_TYPES.videoCompose,
        position: { x: 0, y: 0 },
        data: { displayName: '合成节点', prompt: '合成用的提示词' },
      } as CanvasNode,
    ]);
    openDetail('合成节点');

    const detail = detailPanel();
    expect(within(detail).queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: /资产库/ })).not.toBeInTheDocument();
  });

  it('referenceOnly 引用视频节点不挂表单（对齐工作流不出生成面板）', () => {
    seed([
      emptyVideoNode({
        videoUrl: '/static/ref.mp4',
        displayName: '资产库引用视频',
        referenceOnly: true,
      }),
    ]);
    openDetail('资产库引用视频');

    expect(within(detailPanel()).queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
  });

  it('视频卡空占位文案与详情一致', () => {
    seed([emptyVideoNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);

    // 三栏态下视频卡的空媒体区。
    expect(screen.getByText('待确认后生成')).toBeInTheDocument();
  });
});
