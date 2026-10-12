// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import type { AssetBoardItem } from '@/features/canvas/domain/assetBoard';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AddNodeToChatButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { AssetBoardCard } from '@/features/canvas/ui/asset-board/AssetBoardCard';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

// ImageViewerModal（AssetBoardView 内常驻挂载）用到 useTranslation。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

// 宫格活价用了 react-query，测试树没有 QueryClientProvider —— mock 掉。
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

/** 收集本次点击 publish 出来的 freezone/add-nodes-to-chat 载荷。 */
function captureEvents(run: () => void): string[][] {
  const seen: string[][] = [];
  const unsubscribe = canvasEventBus.subscribe('freezone/add-nodes-to-chat', ({ nodeIds }) => {
    seen.push(nodeIds);
  });
  try {
    run();
  } finally {
    unsubscribe();
  }
  return seen;
}

function boardItem(overrides: Partial<AssetBoardItem> = {}): AssetBoardItem {
  return {
    nodeId: 'n1',
    column: 'video',
    title: '测试卡片',
    mediaUrl: null,
    thumbnailUrl: null,
    textPreview: null,
    model: null,
    durationSec: null,
    widthPx: null,
    heightPx: null,
    videoRole: null,
    references: [],
    timestamp: null,
    isGenerating: false,
    generationError: null,
    generationStartedAt: null,
    keyElementCategory: null,
    ...overrides,
  };
}

describe('添加到对话（画布节点 / 故事板共用入口）', () => {
  it('画布节点右上角按钮 publish 事件，且不冒泡到节点根（根的 onClick 会把选中收成单选）', () => {
    const onRootClick = vi.fn();
    render(
      <div onClick={onRootClick}>
        <AddNodeToChatButton nodeId="img-1" />
      </div>,
    );
    const events = captureEvents(() => {
      fireEvent.click(screen.getByRole('button', { name: '添加到对话' }));
    });
    expect(events).toEqual([['img-1']]);
    expect(onRootClick).not.toHaveBeenCalled();
  });

  // 文字提示走 shadcn Tooltip 而不是原生 title（原生的要悬停约一秒才出，且样式
  // 和产品其它悬浮说明不统一）——回归点：别哪次重构又退回 title。
  it('hover 时弹出「添加到对话」文字提示，且不再挂原生 title', async () => {
    const user = userEvent.setup();
    render(<AddNodeToChatButton nodeId="img-1" />);
    const button = screen.getByRole('button', { name: '添加到对话' });
    expect(button).not.toHaveAttribute('title');

    await user.hover(button);
    expect(await screen.findByText('添加到对话')).toBeInTheDocument();
  });

  it('故事板卡片右上角按钮走同一条事件，且不触发「打开详情」「在画布中定位」', () => {
    const onOpen = vi.fn();
    const onLocate = vi.fn();
    render(
      <AssetBoardCard
        item={boardItem({ nodeId: 'vid-7', title: 'SB-07' })}
        onOpen={onOpen}
        onLocate={onLocate}
        onPreviewImage={() => {}}
      />,
    );
    const events = captureEvents(() => {
      fireEvent.click(screen.getByRole('button', { name: '添加到对话' }));
    });
    expect(events).toEqual([['vid-7']]);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onLocate).not.toHaveBeenCalled();
  });

  // 落地半边（事件 → 虾导 draft 追加 @[名](id) 行内 chip）改由
  // freezone-node-suggestions.test.ts 的 appendFreezoneNodeMentions 单测覆盖。

  describe('故事板详情头部', () => {
    beforeEach(() => {
      const nodes: CanvasNode[] = [
        {
          id: 'text-1',
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: { content: '# 项目信息', displayName: '锚点清单' },
        },
      ];
      const edges: CanvasEdge[] = [];
      useCanvasStore.getState().setCanvasData(nodes, edges);
    });

    // 挂头部而不是媒体工具条：文本栏根本没有工具条，空节点的工具条也整条不渲染，
    // 但这两种节点一样可以被引用进对话。
    it('文本详情（没有媒体工具条）也能「添加到对话」，带的是当前详情节点 id', () => {
      render(<AssetBoardView visible onLocateNode={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: '锚点清单' }));
      const detail = screen.getByRole('region', { name: '资产详情' });
      const events = captureEvents(() => {
        fireEvent.click(within(detail).getByRole('button', { name: '添加到对话' }));
      });
      expect(events).toEqual([['text-1']]);
    });
  });
});
