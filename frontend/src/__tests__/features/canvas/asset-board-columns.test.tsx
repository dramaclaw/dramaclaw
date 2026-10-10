// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardColumn } from '@/features/canvas/ui/asset-board/AssetBoardColumn';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import {
  ASSET_BOARD_COLUMN_FRACTIONS_KEY,
  applyColumnResize,
  readStoredFractions,
} from '@/features/canvas/ui/asset-board/useAssetBoardColumnFractions';
import { useCanvasStore } from '@/stores/canvasStore';

// AssetBoardView 内常驻挂载的 ImageViewerModal / 生成表单用到 useTranslation 与 react-query。
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
      data: { content: '# 项目信息', displayName: '锚点清单' },
    },
    {
      id: 'img-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 100 },
      data: { imageUrl: '/static/img1.png', aspectRatio: '1:1', displayName: '分镜草图' },
    },
    {
      id: 'vid-1',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 300 },
      data: { videoUrl: '/static/v.mp4', aspectRatio: '16:9', displayName: '成片视频' },
    },
  ];
  const edges: CanvasEdge[] = [];
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

function renderBoard() {
  render(<AssetBoardView visible onLocateNode={vi.fn()} />);
}

/** 三栏容器的 getBoundingClientRect 在 jsdom 下恒为 0 宽——桩一个固定宽度供换算。 */
function stubContainerWidth(width: number): HTMLElement {
  const container = screen.getByTestId('asset-board-columns');
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
    width,
    height: 600,
    top: 0,
    left: 0,
    right: width,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return container;
}

function grow(testid: string): number {
  return Number(screen.getByTestId(testid).style.flexGrow);
}

describe('AssetBoard 三栏可拖拽调宽', () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedBoard();
  });

  it('默认等宽：三栏 flexGrow 均为 1/3', () => {
    renderBoard();
    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(1 / 3, 5);
    expect(grow('asset-board-column-wrapper-image')).toBeCloseTo(1 / 3, 5);
    expect(grow('asset-board-column-wrapper-video')).toBeCloseTo(1 / 3, 5);
  });

  it('拖动文本/图片分隔条：向右加宽文本、收窄图片（flexGrow 变化，视频不动）', () => {
    renderBoard();
    stubContainerWidth(900);
    const resizer = screen.getByTestId('asset-board-resizer-0');

    fireEvent.pointerDown(resizer, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(resizer, { clientX: 390, pointerId: 1 }); // +90px → +0.1 份额

    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(1 / 3 + 0.1, 4);
    expect(grow('asset-board-column-wrapper-image')).toBeCloseTo(1 / 3 - 0.1, 4);
    expect(grow('asset-board-column-wrapper-video')).toBeCloseTo(1 / 3, 4);
  });

  it('拖动图片/视频分隔条：只在图片与视频间转移份额（文本不动）', () => {
    renderBoard();
    stubContainerWidth(900);
    const resizer = screen.getByTestId('asset-board-resizer-1');

    fireEvent.pointerDown(resizer, { clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(resizer, { clientX: 690, pointerId: 1 });

    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(1 / 3, 4);
    expect(grow('asset-board-column-wrapper-image')).toBeCloseTo(1 / 3 + 0.1, 4);
    expect(grow('asset-board-column-wrapper-video')).toBeCloseTo(1 / 3 - 0.1, 4);
  });

  it('松手落库：pointerUp 后比例写入 localStorage（和为 1，反映拖拽结果）', () => {
    renderBoard();
    stubContainerWidth(900);
    const resizer = screen.getByTestId('asset-board-resizer-0');

    fireEvent.pointerDown(resizer, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(resizer, { clientX: 390, pointerId: 1 });
    // 落库前 localStorage 仍为空（只有松手才写）。
    expect(window.localStorage.getItem(ASSET_BOARD_COLUMN_FRACTIONS_KEY)).toBeNull();

    fireEvent.pointerUp(resizer, { clientX: 390, pointerId: 1 });

    const stored = readStoredFractions();
    expect(stored[0] + stored[1] + stored[2]).toBeCloseTo(1, 5);
    expect(stored[0]).toBeCloseTo(1 / 3 + 0.1, 4);
    expect(stored[1]).toBeCloseTo(1 / 3 - 0.1, 4);
  });

  it('刷新恢复：预置 localStorage → 初始 flexGrow 反映存储比例', () => {
    window.localStorage.setItem(ASSET_BOARD_COLUMN_FRACTIONS_KEY, JSON.stringify([0.5, 0.3, 0.2]));
    renderBoard();
    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(0.5, 5);
    expect(grow('asset-board-column-wrapper-image')).toBeCloseTo(0.3, 5);
    expect(grow('asset-board-column-wrapper-video')).toBeCloseTo(0.2, 5);
  });

  it('脏值回落等宽：非法 JSON / 结构 / 数值 → 三栏各 1/3', () => {
    for (const dirty of ['not-json', '[0.5,0.5]', '[1,2,"x"]', '[-1,1,1]', '[0,1,1]', '{"a":1}']) {
      window.localStorage.setItem(ASSET_BOARD_COLUMN_FRACTIONS_KEY, dirty);
      const stored = readStoredFractions();
      expect(stored[0]).toBeCloseTo(1 / 3, 5);
      expect(stored[1]).toBeCloseTo(1 / 3, 5);
      expect(stored[2]).toBeCloseTo(1 / 3, 5);
    }
  });

  it('最小宽度：向左拖到底，图片栏不塌陷（保持 >= 200/900 份额），文本收到最小', () => {
    renderBoard();
    stubContainerWidth(900);
    const resizer = screen.getByTestId('asset-board-resizer-0');

    fireEvent.pointerDown(resizer, { clientX: 300, pointerId: 1 });
    // 向左狂拖 500px，远超可用空间。
    fireEvent.pointerMove(resizer, { clientX: -200, pointerId: 1 });

    const minFrac = 200 / 900;
    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(minFrac, 4);
    // 份额从文本转给图片，图片增大而非塌陷。
    expect(grow('asset-board-column-wrapper-image')).toBeGreaterThan(1 / 3);
  });

  it('详情态隔离：进详情后三栏容器整体卸载（fractions 不生效于详情布局）', () => {
    window.localStorage.setItem(ASSET_BOARD_COLUMN_FRACTIONS_KEY, JSON.stringify([0.5, 0.3, 0.2]));
    renderBoard();
    expect(screen.getByTestId('asset-board-columns')).toBeInTheDocument();

    // 点开图片卡进详情。
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));
    expect(screen.queryByTestId('asset-board-columns')).not.toBeInTheDocument();

    // 退回总览 → 重挂载并从 localStorage 恢复比例。
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    expect(screen.getByTestId('asset-board-columns')).toBeInTheDocument();
    expect(grow('asset-board-column-wrapper-text')).toBeCloseTo(0.5, 5);
  });
});

describe('视频栏筛选下拉', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'vid-final',
          type: CANVAS_NODE_TYPES.videoCompose,
          position: { x: 0, y: 0 },
          data: { videoUrl: '/static/final.mp4', displayName: '成片一号' },
        },
        {
          id: 'vid-clip',
          type: CANVAS_NODE_TYPES.video,
          position: { x: 0, y: 200 },
          data: { videoUrl: '/static/clip.mp4', displayName: '片段一号' },
        },
      ],
      [],
    );
  });

  it('默认「全部」：两类视频都在列表里，展开菜单时「全部」打勾', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    expect(screen.getByRole('button', { name: '成片一号' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '片段一号' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /全部/ }));
    const menu = screen.getByRole('menu', { name: '筛选视频' });
    expect(within(menu).getByRole('menuitemradio', { name: '全部' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('选「成片」→ 只留成片，触发器文案跟着变；再选回「全部」恢复', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /全部/ }));
    fireEvent.click(
      within(screen.getByRole('menu', { name: '筛选视频' })).getByRole('menuitemradio', {
        name: '成片',
      }),
    );
    expect(screen.getByRole('button', { name: '成片一号' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '片段一号' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /成片$/ }));
    fireEvent.click(
      within(screen.getByRole('menu', { name: '筛选视频' })).getByRole('menuitemradio', {
        name: '全部',
      }),
    );
    expect(screen.getByRole('button', { name: '片段一号' })).toBeInTheDocument();
  });
});

describe('图片/视频栏放大', () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedBoard();
  });

  it('点图片栏「放大」→ 三栏收成「左列 + 图片宽幅网格」，再点「收起」还原', () => {
    renderBoard();
    // 三栏态：图片与视频栏各有一颗放大按钮。
    expect(screen.getAllByRole('button', { name: '放大' })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: '放大' })[0]);
    // 放大后三栏容器让位；右侧只剩被放大的那栏（收起按钮唯一）。
    expect(screen.queryByTestId('asset-board-columns')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument();
    // 网格里照常能看到该栏条目，左边保留文本栏。
    expect(screen.getByRole('button', { name: '分镜草图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '锚点清单' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.getByTestId('asset-board-columns')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '放大' })).toHaveLength(2);
  });

  it('详情态左窄列表不出「放大」按钮（那里点了不会有任何变化）', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));

    // 左列此刻是图片栏（详情所在栏），但放大在详情态无意义 → 不该渲染这颗按钮，
    // 否则点了没反应，且关掉详情后会突然跳进放大态。
    expect(screen.queryByRole('button', { name: '放大' })).not.toBeInTheDocument();
  });

  it('放大态左列（文本栏）也不出「放大」按钮', () => {
    renderBoard();
    fireEvent.click(screen.getAllByRole('button', { name: '放大' })[0]);
    // 只剩被放大那栏的「收起」，左列文本栏本来就没有放大入口。
    expect(screen.queryByRole('button', { name: '放大' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument();
  });

  it('放大态点卡片开详情；关掉详情回到放大态而不是三栏', () => {
    renderBoard();
    fireEvent.click(screen.getAllByRole('button', { name: '放大' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));

    const detail = screen.getByRole('region', { name: '资产详情' });
    expect(detail).toBeInTheDocument();

    fireEvent.click(within(detail).getByRole('button', { name: '关闭详情' }));
    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument();
    expect(screen.queryByTestId('asset-board-columns')).not.toBeInTheDocument();
  });
});

describe('AssetBoardColumn 条目分割线', () => {
  it('dividedItems：N 个条目之间插 N-1 条分割线（不在首尾多画）', () => {
    render(
      <AssetBoardColumn title="图片" count={3} emptyText="空" dividedItems>
        <div>卡片1</div>
        <div>卡片2</div>
        <div>卡片3</div>
      </AssetBoardColumn>,
    );
    expect(screen.getAllByTestId('asset-board-item-divider')).toHaveLength(2);
  });

  it('不传 dividedItems（文本栏）→ 一条分割线都不画', () => {
    render(
      <AssetBoardColumn title="文本" count={2} emptyText="空">
        <div>文本1</div>
        <div>文本2</div>
      </AssetBoardColumn>,
    );
    expect(screen.queryByTestId('asset-board-item-divider')).not.toBeInTheDocument();
  });

  it('分割线是独立元素、自带底色——不靠卡片边框（卡片 border-transparent 会把 divide-* 刷没）', () => {
    render(
      <AssetBoardColumn title="图片" count={2} emptyText="空" dividedItems>
        <div className="border border-transparent">卡片1</div>
        <div className="border border-transparent">卡片2</div>
      </AssetBoardColumn>,
    );
    const divider = screen.getByTestId('asset-board-item-divider');
    expect(divider.className).toContain('bg-white/10');
  });
});

describe('applyColumnResize 纯函数', () => {
  const start = [1 / 3, 1 / 3, 1 / 3] as const;

  it('相邻两栏转移份额、其余不动、和恒为 1', () => {
    const next = applyColumnResize(start, 0, 90, 900, 200);
    expect(next[0]).toBeCloseTo(1 / 3 + 0.1, 5);
    expect(next[1]).toBeCloseTo(1 / 3 - 0.1, 5);
    expect(next[2]).toBeCloseTo(1 / 3, 5);
    expect(next[0] + next[1] + next[2]).toBeCloseTo(1, 5);
  });

  it('钳制最小宽度：两栏都不低于 minPx/width', () => {
    const next = applyColumnResize(start, 1, 100000, 900, 200);
    const minFrac = 200 / 900;
    expect(next[2]).toBeCloseTo(minFrac, 5);
    expect(next[1]).toBeGreaterThan(1 / 3);
  });

  it('零宽兜底：width<=0 时不位移', () => {
    const next = applyColumnResize(start, 0, 90, 0, 200);
    expect(next[0]).toBeCloseTo(1 / 3, 5);
    expect(next[1]).toBeCloseTo(1 / 3, 5);
  });
});
