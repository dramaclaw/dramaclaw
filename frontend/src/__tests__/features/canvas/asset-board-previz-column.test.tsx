// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
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
      id: 'text-1',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 0 },
      data: { content: '正文', displayName: '锚点清单' },
    },
    {
      id: 'previz-1',
      type: CANVAS_NODE_TYPES.previz,
      position: { x: 0, y: 100 },
      data: { displayName: '机位预演', summary: { objectCount: 2, durationFrames: 48 } },
    },
  ] as unknown as CanvasNode[];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

describe('故事板第一栏：文本 / 预演台 下拉切换', () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedBoard();
  });

  it('默认显示文本，下拉切到预演台后列出预演台节点与摘要', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    expect(screen.getByText('锚点清单')).toBeTruthy();
    expect(screen.queryByText('机位预演')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /文本/ }));
    const menu = screen.getByRole('menu', { name: '切换第一栏' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /预演台/ }));

    expect(screen.getByText('机位预演')).toBeTruthy();
    expect(screen.getByText('2 个对象 · 48 帧')).toBeTruthy();
    expect(screen.queryByText('锚点清单')).toBeNull();
  });

  it('点预演台卡片直接跳回画布定位（编辑器在画布节点里），不开故事板详情', () => {
    const onLocateNode = vi.fn();
    render(<AssetBoardView visible onLocateNode={onLocateNode} />);
    fireEvent.click(screen.getByRole('button', { name: /文本/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /预演台/ }));

    fireEvent.click(screen.getByText('机位预演'));
    expect(onLocateNode).toHaveBeenCalledWith('previz-1');
    expect(screen.queryByRole('menu', { name: '切换栏目' })).toBeNull();
  });
});
