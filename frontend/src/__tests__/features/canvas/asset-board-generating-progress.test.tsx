// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 覆盖故事板「生成中态进度百分比」对齐 liblib 的两件事：
// 1. 前提验证——详情态下左侧窄列表是否真的实时（新 spawn 的生成中节点会自动
//    出现在列表里）。AssetBoardView 的 board 数据源在故事板可见时不冻结
//    （buildAssetBoard(nodes, edges) 订阅 store 的实时 nodes/edges），理论上
//    成立；这里用真实 store + 真实 addNode（同「多角度」编排 imageMultiAngle.ts
//    的 spawn 方式：addNode 一个 isGenerating 的 exportImage 节点）跑一遍来实测，
//    而不是只读代码猜。
// 2. 新功能——卡片标题旁的「生成中」小字升级成「生成中 X%...」百分比（时间估算，
//    按 generationStartedAt + 预估 durationMs 线性插值，与工作流 NodeGenerationOverlay
//    共享同一算法）。
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

function seedBoard() {
  const nodes: CanvasNode[] = [
    {
      id: 'img-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/img1.png', aspectRatio: '1:1', displayName: '已有图片' },
    },
  ];
  const edges: CanvasEdge[] = [];
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

function renderBoard() {
  render(<AssetBoardView visible onLocateNode={vi.fn()} />);
}

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

describe('故事板生成中态：新节点进左列表 + 进度百分比', () => {
  beforeEach(() => {
    seedBoard();
  });

  it('图片详情态下 spawn 一个生成中的图片节点（同「多角度」用 addNode+addEdge 的方式）→ 出现在左侧窄列表，渲染生成中态', () => {
    renderBoard();
    // 先进图片详情（对齐用户场景：编辑/生成时人正停留在某个详情里）。
    fireEvent.click(screen.getByRole('button', { name: '已有图片' }));
    expect(within(detailPanel()).getByText('已有图片')).toBeInTheDocument();
    // 主从布局下左侧只剩图片栏窄列表。
    expect(screen.getByText('图片')).toBeInTheDocument();

    // 像 imageMultiAngle.ts 编排那样：同步 addNode 一个 isGenerating 的结果节点
    // 并连边到源节点——不是替换整个 nodes 数组（setCanvasData），而是增量 spawn。
    act(() => {
      const store = useCanvasStore.getState();
      const newNodeId = store.addNode(
        CANVAS_NODE_TYPES.exportImage,
        { x: 200, y: 0 },
        {
          displayName: '多角度候选',
          imageUrl: null,
          previewImageUrl: null,
          aspectRatio: '1:1',
          isGenerating: true,
          generationStartedAt: Date.now(),
        },
      );
      store.addEdge('img-1', newNodeId);
    });

    // 断言 A：新节点确实出现在左侧窄列表（board 数据源实时，未被详情态冻结）。
    const imageList = screen.getByText('图片').closest('section') as HTMLElement;
    expect(within(imageList).getByRole('button', { name: '多角度候选' })).toBeInTheDocument();
    // 断言 B：以生成中态渲染——标题旁百分比小字 + 媒体区 spinner 覆层。
    expect(within(imageList).getByText(/^生成中 \d+%\.\.\.$/)).toBeInTheDocument();
    expect(within(imageList).getAllByRole('status', { name: '生成中' }).length).toBeGreaterThan(0);
    // 原有详情（已有图片）没被打断——左列表新增一项，不影响右侧正在看的详情。
    expect(within(detailPanel()).getByText('已有图片')).toBeInTheDocument();
  });

  it('百分比随时间推进：卡片文案从 0% 增长，图片栏预估时长 20s', () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      act(() => {
        const store = useCanvasStore.getState();
        store.addNode(
          CANVAS_NODE_TYPES.exportImage,
          { x: 200, y: 0 },
          {
            displayName: '生成中候选',
            imageUrl: null,
            aspectRatio: '1:1',
            isGenerating: true,
            generationStartedAt: startedAt,
          },
        );
      });
      renderBoard();

      expect(screen.getByText('生成中 0%...')).toBeInTheDocument();

      // 4s / 20s 预估经指数饱和算法约为 24%（120ms 轮询节拍，最后一拍落在 3960ms）。
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.getByText('生成中 24%...')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('生成完成（isGenerating 变 false）→ 百分比小字消失，卡片回到常态', () => {
    act(() => {
      const store = useCanvasStore.getState();
      const id = store.addNode(
        CANVAS_NODE_TYPES.exportImage,
        { x: 200, y: 0 },
        { displayName: '完成中候选', imageUrl: null, aspectRatio: '1:1', isGenerating: true, generationStartedAt: Date.now() },
      );
      store.updateNodeData(id, {
        imageUrl: '/static/done.png',
        previewImageUrl: '/static/done.png',
        isGenerating: false,
        generationStartedAt: null,
      });
    });
    renderBoard();

    expect(screen.queryByText(/^生成中 \d+%\.\.\.$/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '完成中候选' })).toBeInTheDocument();
  });
});
