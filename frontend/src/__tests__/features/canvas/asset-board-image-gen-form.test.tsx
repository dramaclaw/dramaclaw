// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { submitFreezoneGen } from '@/api/ops';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
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
  fetchFreezoneImageModels: vi.fn(async () => [
    {
      id: 'huimeng/test-image',
      providerId: 'huimeng',
      apiModel: 'test_image_api',
      label: '测试模型',
    },
  ]),
  listFreezoneStyleTemplates: vi.fn(async () => []),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneGen: vi.fn(async () => ({
    task_key: 'task-1',
    task_type: 'freezone_gen',
    job_id: 'job-1',
  })),
  fetchFreezoneJobResult: vi.fn(async () => ({ url: '/static/out.png' })),
}));

vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/tasks')>()),
  awaitTaskCompletion: vi.fn(async () => ({
    result: { output_url: '/static/out.png' },
  })),
}));

function seed(nodes: CanvasNode[]) {
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function emptyImageGenNode(overrides: Partial<CanvasNode['data']> = {}): CanvasNode {
  return {
    id: 'gen-1',
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: {
      imageUrl: null,
      prompt: '',
      aspectRatio: '16:9',
      size: '2K',
      displayName: '图片节点 3',
      ...overrides,
    },
  };
}

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

function openDetail(name: string) {
  render(<AssetBoardView visible onLocateNode={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('故事板详情 · 图片生成表单', () => {
  beforeEach(() => {
    vi.mocked(submitFreezoneGen).mockClear();
  });

  it('空 imageGen 节点：媒体区显示「待确认后生成」占位，下方挂完整生成表单', () => {
    seed([emptyImageGenNode()]);
    openDetail('图片节点 3');

    const detail = detailPanel();
    // 空态占位（无大图可放大）。
    expect(within(detail).getAllByText('待确认后生成').length).toBeGreaterThan(0);
    expect(within(detail).queryByRole('button', { name: '放大查看' })).not.toBeInTheDocument();
    // 生成条：风格 / 资产库 chips + 提示词输入 + 参数 + 翻译 + 提交。
    expect(within(detail).getByRole('button', { name: '风格' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: /资产库/ })).toBeInTheDocument();
    // 提示词编辑器是 contenteditable，占位走 data-placeholder + ::before。
    expect(
      detail.querySelector('[data-placeholder="描述你想要生成的画面内容，@引用素材"]'),
    ).not.toBeNull();
    expect(within(detail).getByRole('button', { name: '生成' })).toBeInTheDocument();
  });

  it('有提示词 → 点提交走真实提交链路（submitFreezoneGen 收到该 prompt）', async () => {
    seed([emptyImageGenNode({ prompt: '一只在雪夜里发光的小猫' })]);
    openDetail('图片节点 3');

    const submit = within(detailPanel()).getByRole('button', { name: '生成' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(submitFreezoneGen).toHaveBeenCalled());
    const [project, payload] = vi.mocked(submitFreezoneGen).mock.calls[0];
    expect(project).toBe('demo-project');
    expect(payload.prompt).toBe('一只在雪夜里发光的小猫');
    expect(payload.nodeId).toBe('gen-1');
  });

  it('提示词为空且无上游文本 → 提交按钮禁用', () => {
    seed([emptyImageGenNode()]);
    openDetail('图片节点 3');

    expect(within(detailPanel()).getByRole('button', { name: '生成' })).toBeDisabled();
  });

  it('已有产物的 imageGen 节点仍挂表单，且不再重复渲染只读提示词块', () => {
    seed([
      emptyImageGenNode({
        imageUrl: '/static/done.png',
        prompt: '已经出图的提示词',
      }),
    ]);
    openDetail('图片节点 3');

    const detail = detailPanel();
    expect(within(detail).getByRole('button', { name: '放大查看' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '生成' })).toBeInTheDocument();
    // 只读展示块的小标题不出现——提示词只由表单里的输入框承载一份。
    expect(within(detail).queryByText('提示词')).not.toBeInTheDocument();
    // prompt 文本只出现一次（表单输入框里那份）。
    expect(within(detail).getAllByText('已经出图的提示词')).toHaveLength(1);
  });

  it('非图片生成节点（上传节点）详情不出现生成表单，只读提示词块照旧', () => {
    seed([
      {
        id: 'up-1',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/up.png', aspectRatio: '1:1', displayName: '角色参考' },
      },
      {
        id: 'edit-1',
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 200, y: 0 },
        data: {
          imageUrl: '/static/edit.png',
          prompt: '把背景改成雪夜',
          aspectRatio: '1:1',
          displayName: '编辑图片',
        },
      },
    ]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '角色参考' }));
    expect(within(detailPanel()).queryByRole('button', { name: '生成' })).not.toBeInTheDocument();
    expect(within(detailPanel()).queryByRole('button', { name: /资产库/ })).not.toBeInTheDocument();

    // imageEdit 有它自己的一套表单（后续切片），本片不接：仍是只读提示词展示。
    fireEvent.click(screen.getByRole('button', { name: '编辑图片' }));
    expect(within(detailPanel()).queryByRole('button', { name: '生成' })).not.toBeInTheDocument();
    expect(within(detailPanel()).getByText('提示词')).toBeInTheDocument();
    expect(within(detailPanel()).getByText('把背景改成雪夜')).toBeInTheDocument();
  });

  it('imageGen 自带参考图（referenceImageUrl，无上游）→ 表单区补显示自带参考 chip，不走底部只读行', () => {
    seed([
      emptyImageGenNode({
        imageUrl: '/static/done.png',
        referenceImageUrl: '/static/own-ref.png',
        displayName: '带参考图的节点',
      }),
    ]);
    openDetail('带参考图的节点');

    const detail = detailPanel();
    // 生成表单在场 → 底部「参考素材」只读行被收掉（避免与表单 chip 重复）。
    expect(within(detail).queryByRole('group', { name: '参考素材' })).not.toBeInTheDocument();
    // 共用表单不渲自带参考图，宿主在表单区补一枚 chip（用 referenceImageUrl），
    // 保证自带参考图不因底部行隐藏而消失。
    const ownRef = within(detail).getByAltText('参考图');
    expect(ownRef).toHaveAttribute('src', '/static/own-ref.png');
  });

  it('表单区自带参考 chip 的「移除参考图」→ 清空 referenceImageUrl，chip 消失', () => {
    seed([
      emptyImageGenNode({
        imageUrl: '/static/done.png',
        referenceImageUrl: '/static/own-ref.png',
        displayName: '带参考图的节点',
      }),
    ]);
    openDetail('带参考图的节点');

    const detail = detailPanel();
    expect(within(detail).getByAltText('参考图')).toBeInTheDocument();
    // 移除按钮默认 hover 才显现（display:none），用 title 直接取到并点击。
    fireEvent.click(within(detail).getByTitle('移除参考图'));

    expect(within(detail).queryByAltText('参考图')).not.toBeInTheDocument();
    const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === 'gen-1');
    expect((node?.data as { referenceImageUrl?: string | null }).referenceImageUrl).toBeNull();
  });

  it('imageGen 有上游引用 → 底部只读行不出现，引用只由表单 chip 承载（不重复）', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'up-ref',
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: '/static/up-ref.png', aspectRatio: '1:1', displayName: '上游参考' },
        },
        emptyImageGenNode({ imageUrl: '/static/done.png', prompt: '已出图', displayName: '图片节点 3' }),
      ],
      [{ id: 'e-up', source: 'up-ref', target: 'gen-1' }],
    );
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '图片节点 3' }));

    const detail = detailPanel();
    // 生成表单在场 → 无底部「参考素材」只读行。
    expect(within(detail).queryByRole('group', { name: '参考素材' })).not.toBeInTheDocument();
    // 上游引用作为表单引用 chip 出现（chip 容器 title="来自上游 · 上游参考"）。
    expect(within(detail).getByTitle('来自上游 · 上游参考')).toBeInTheDocument();
  });

  it('图片卡空占位文案与详情一致', () => {
    seed([emptyImageGenNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);

    // 三栏态下图片卡的空媒体区。
    expect(screen.getByText('待确认后生成')).toBeInTheDocument();
  });
});
